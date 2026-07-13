// The HTTP core: one hardened request path shared by every SDK method. It injects the bearer, bounds
// each request with a wall-clock timeout, retries only IDEMPOTENT requests on transient failures (with
// jittered backoff that honours `Retry-After`), performs a single reactive bearer refresh on a 401, and
// resolves every non-2xx response — a JSON `{error,message}` envelope, an empty-body 401/403, or a
// text/plain router miss — into a typed error. Every human-facing string is redacted first.

import {
  WebhookUnexpectedResponseError,
  errorFromResponse,
  errorFromTransport,
  type WebhookErrorCode,
} from "./errors.js";
import { createRedactor } from "./redaction.js";
import { userAgent } from "./version.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  backoffMs,
  isRetryableStatus,
  parseRetryAfter,
} from "./retry.js";

/** The set of capability codes, used to validate a server-sent `error` string before trusting it. */
const WEBHOOK_ERROR_CODES: ReadonlySet<string> = new Set<WebhookErrorCode>([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "ENDPOINT_PAUSED",
  "RATE_LIMITED",
  "TARGET_UNREACHABLE",
]);

function asWebhookErrorCode(value: unknown): WebhookErrorCode | undefined {
  return typeof value === "string" && WEBHOOK_ERROR_CODES.has(value)
    ? (value as WebhookErrorCode)
    : undefined;
}

export interface HttpClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injected fetch (the platform global in production; a stub in tests). */
  readonly fetch: typeof fetch;
  /** Retries AFTER the first attempt (default `DEFAULT_MAX_RETRIES`). */
  readonly maxRetries?: number;
  /** Backoff sleep between retries (real `setTimeout` in prod; instant under test). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source for the backoff (`Math.random` in prod; deterministic under test). */
  readonly rand?: () => number;
  /** Per-request wall-clock budget (default `DEFAULT_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
  /** The per-request timeout signal factory (default `AbortSignal.timeout`; injectable for tests). */
  readonly timeoutSignal?: () => AbortSignal;
  /**
   * Reactive auth hook for a rotatable credential: invoked AT MOST ONCE per request on a 401, returning
   * a fresh bearer to retry with, or null to give up (→ surface the 401). Absent for a static API key.
   */
  readonly refreshAuth?: () => Promise<string | null>;
  /** Optional debug sink. Receives already-redacted, single-line diagnostics (never the raw key). */
  readonly onDebug?: (line: string) => void;
  /** Called (at most once) with a version advisory from the server. Injected by the client. */
  readonly reportAdvisory?: (
    header: string | null | undefined,
    deprecation: string | null | undefined,
  ) => void;
}

/** A single request to make. `idempotent` gates whether a transient failure may be retried. */
export interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  /** A JSON-serialisable body; omitted → no body and no content-type header. */
  readonly body?: unknown;
  readonly idempotent: boolean;
}

export interface HttpClient {
  request(spec: RequestSpec): Promise<unknown>;
}

/** Parse a successful response's JSON body; a malformed body is an unexpected-response error. */
async function parseSuccess(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new WebhookUnexpectedResponseError("the API returned a malformed JSON response", {
      status: res.status,
    });
  }
}

/** Resolve a non-2xx response into a typed error across the three wire shapes. */
async function buildResponseError(res: Response, redact: (s: string) => string): Promise<never> {
  const status = res.status;
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const retryAfterMs = status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
  const contentType = res.headers.get("content-type") ?? "";

  let code: WebhookErrorCode | undefined;
  let message: string | undefined;
  if (contentType.includes("application/json")) {
    const body = (await res.json().catch(() => undefined)) as unknown;
    if (body !== null && typeof body === "object") {
      code = asWebhookErrorCode((body as Record<string, unknown>)["error"]);
      const rawMessage = (body as Record<string, unknown>)["message"];
      if (typeof rawMessage === "string") message = redact(rawMessage);
    }
  } else {
    // Empty-body 401/403 or a text/plain router miss: use whatever text is present as the message.
    const text = await res.text().catch(() => "");
    if (text.trim().length > 0) message = redact(text.trim());
  }
  throw errorFromResponse({ status, code, message, requestId, retryAfterMs });
}

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rand = config.rand ?? Math.random;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const makeTimeoutSignal = config.timeoutSignal ?? (() => AbortSignal.timeout(timeoutMs));

  async function request(spec: RequestSpec): Promise<unknown> {
    // The live bearer — replaced when the refresh hook hands back a rotated token. A 401 refresh+retry is
    // safe for ANY method (a 401 means the request was rejected, never processed), so it is NOT gated on
    // idempotency; it fires at most once (a second 401 surfaces the error).
    let bearer = config.apiKey;
    let refreshed = false;
    // Redaction is owned here (not the caller) so a bearer rotated mid-request by `refreshAuth` is added
    // to the secret set — otherwise a non-`whk_`-shaped rotated token would slip the structural backstop.
    const secrets = [config.apiKey];
    let redact = createRedactor(secrets);
    const debug = (line: string): void => config.onDebug?.(redact(line));
    for (let attempt = 0; ; attempt += 1) {
      const isLastAttempt = attempt >= maxRetries;
      debug(`${spec.method} ${spec.path} attempt=${attempt + 1}`);
      let res: Response;
      try {
        res = await config.fetch(`${config.baseUrl}${spec.path}`, {
          method: spec.method,
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
            // Identify the client + version. This is what lets the server answer with a version advisory on
            // a response you already asked for, instead of the SDK polling npm behind your back.
            "user-agent": userAgent(),
            ...(spec.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
          // A webhook REST API never legitimately 3xx-redirects; refuse to follow one so the
          // Authorization header can't be replayed to an attacker-chosen (cross-origin) host.
          redirect: "error",
          signal: makeTimeoutSignal(),
        });
      } catch {
        // A transport failure (DNS/TLS/connection) or a timeout (the signal aborted). The cause is
        // dropped so a raw error string can't carry anything sensitive into output.
        if (spec.idempotent && !isLastAttempt) {
          const ms = backoffMs(attempt + 1, rand);
          debug(`transport failure; retrying in ${ms}ms`);
          await sleep(ms);
          continue;
        }
        throw errorFromTransport(config.baseUrl);
      }

      // The server rides a version advisory on a response we already asked for. Surface it (at most once)
      // regardless of status: a client that is too old to work is precisely the one seeing errors.
      config.reportAdvisory?.(
        res.headers.get("x-webhook-advisory"),
        res.headers.get("deprecation"),
      );

      if (res.ok) return parseSuccess(res);

      // A 401 → one silent refresh + retry (the hook may return null to decline). The refreshed retry is
      // a fresh request, not a spent attempt, so the attempt counter is rewound.
      if (res.status === 401 && config.refreshAuth !== undefined && !refreshed) {
        refreshed = true;
        const next = await config.refreshAuth();
        if (next !== null) {
          bearer = next;
          secrets.push(next);
          redact = createRedactor(secrets);
          attempt -= 1;
          debug("refreshed bearer; retrying");
          continue;
        }
      }

      if (spec.idempotent && !isLastAttempt && isRetryableStatus(res.status)) {
        const ms = parseRetryAfter(res.headers.get("retry-after")) ?? backoffMs(attempt + 1, rand);
        debug(`transient ${res.status}; retrying in ${ms}ms`);
        await sleep(ms);
        continue;
      }
      return buildResponseError(res, redact);
    }
  }

  return { request };
}
