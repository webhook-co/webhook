import {
  AuthContextSchema,
  auditVerify as auditVerifyCap,
  endpointsAddProviderSecret as endpointsAddProviderSecretCap,
  endpointsCreate as endpointsCreateCap,
  endpointsDelete as endpointsDeleteCap,
  endpointsGet as endpointsGetCap,
  endpointsList as endpointsListCap,
  endpointsListProviderSecrets as endpointsListProviderSecretsCap,
  endpointsRevokeProviderSecret as endpointsRevokeProviderSecretCap,
  endpointsRotate as endpointsRotateCap,
  eventsGet as eventsGetCap,
  eventsGetPayload as eventsGetPayloadCap,
  eventsList as eventsListCap,
  eventsReplay as eventsReplayCap,
  type AddedProviderSecret,
  type AuthContext,
  type CapabilityError,
  type CreatedEndpoint,
  type DeletedEndpoint,
  type ProviderSecretSummary,
  type RevokedProviderSecret,
  type Target,
} from "@webhook-co/contract";
import {
  b64ToBytes,
  type DeliveryAttempt,
  type Endpoint,
  type Event,
  type EventSummary,
  type Provider,
} from "@webhook-co/shared";
import type { z } from "zod";

import { CliError, InvalidApiUrlError, InvalidTunnelUrlError } from "./errors.js";
import { EXIT, exitCodeForCapabilityError } from "./output/exit-codes.js";
import {
  apiBackoffMs,
  API_MAX_ATTEMPTS,
  API_TIMEOUT_MS,
  isRetryableStatus,
  parseRetryAfter,
} from "./retry.js";

// The CLI's Bearer HTTP client for the webhook.co REST API (api.webhook.co). It attaches the API key
// as `Authorization: Bearer …`, maps an HTTP status back to the closed CapabilityError taxonomy (the
// inverse of apps/api's http-status map), and parses every response against the SHARED contract output
// schema for that capability — so the CLI can't drift from the server's shape. `fetch` is injected so
// the client + every command is node-tested with no network.

/** The canonical hosted API. Overridable via `--api-url` or `WBHK_API_URL` (self-host / dev). */
export const DEFAULT_API_BASE_URL = "https://api.webhook.co";

/** Env var overriding the API base URL (sticky alternative to the per-invocation `--api-url`). */
export const ENV_API_URL_VAR = "WBHK_API_URL";

/** The canonical listen-tunnel origin (the engine on the cookieless ingestion apex). */
export const DEFAULT_TUNNEL_URL = "wss://wbhk.my";

/** Env var overriding the tunnel URL (self-host / dev), the sticky alternative to `--tunnel-url`. */
export const ENV_TUNNEL_URL_VAR = "WBHK_TUNNEL_URL";

/** The canonical web dashboard (where the in-tail TUI's `o` key opens an event). Overridable for self-host. */
export const DEFAULT_DASHBOARD_URL = "https://app.webhook.co";

/** Env var overriding the dashboard origin (self-host / dev). */
export const ENV_DASHBOARD_URL_VAR = "WBHK_DASHBOARD_URL";

/**
 * A typed API failure. A closed-taxonomy `code` maps to its stable CLI exit code; an absent code
 * (a transport failure or an unexpected server response) is UNEXPECTED (exit 1). Extends CliError so
 * the app's single error formatter + `determineExitCode` handle it uniformly with every other error.
 */
export class ApiError extends CliError {
  readonly exitCode: number;
  readonly userMessage: string;
  constructor(
    readonly code: CapabilityError | undefined,
    userMessage: string,
  ) {
    super(userMessage);
    this.name = "ApiError";
    this.userMessage = userMessage;
    this.exitCode = code !== undefined ? exitCodeForCapabilityError(code) : EXIT.UNEXPECTED;
  }
}

/** HTTP status → CapabilityError (inverse of apps/api/src/http-status.ts; total over the taxonomy). */
const STATUS_TO_CAPABILITY: Readonly<Record<number, CapabilityError>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "ENDPOINT_PAUSED",
  429: "RATE_LIMITED",
  502: "TARGET_UNREACHABLE",
};

/** Concise, on-voice messages per capability error (the code carries the machine-readable signal). */
const MESSAGE: Record<CapabilityError, string> = {
  UNAUTHORIZED: "authentication failed — the api key is invalid, expired, or revoked",
  FORBIDDEN: "the api key is missing a required scope for this action",
  NOT_FOUND: "not found",
  VALIDATION_ERROR: "the request was rejected as invalid",
  RATE_LIMITED: "rate limited — wait a moment and retry",
  ENDPOINT_PAUSED: "the endpoint is paused",
  TARGET_UNREACHABLE: "the delivery target was unreachable",
};

function errorForStatus(status: number): ApiError {
  const code = STATUS_TO_CAPABILITY[status];
  return code !== undefined
    ? new ApiError(code, MESSAGE[code])
    : new ApiError(undefined, `the api returned an unexpected response (HTTP ${status})`);
}

/** A single page of a paginated read: a slice of items + the opaque cursor for the next page (null at end). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Pagination inputs shared by the list calls. */
export interface ListParams {
  readonly cursor?: string;
  readonly limit?: number;
}

/** endpoints.list adds an optional case-insensitive substring name filter. */
export interface EndpointsListParams extends ListParams {
  readonly name?: string;
}

/** events.list adds optional provider + received-at range + verification-state filters. */
export interface EventsListParams extends ListParams {
  readonly provider?: string;
  readonly receivedAfter?: string;
  readonly receivedBefore?: string;
  readonly verificationState?: string;
}

/** The audit-chain verification result (the shared `audit.verify` output: ok + rowsVerified, or a break). */
export type AuditVerifyResult = z.infer<typeof auditVerifyCap.output>;

export interface ApiClient {
  /** Resolve the caller's own identity — validates the key (`GET /v1/whoami`). */
  whoami(): Promise<AuthContext>;
  /** A page of the org's endpoints (`GET /v1/endpoints`), optionally filtered by `name` substring. */
  endpointsList(params?: EndpointsListParams): Promise<Page<Endpoint>>;
  /** A single endpoint by id (`GET /v1/endpoints/:id`). */
  endpointsGet(endpointId: string): Promise<Endpoint>;
  /**
   * Create an endpoint (`POST /v1/endpoints`). NOT idempotent — each call mints a new endpoint + a
   * one-time ingest URL (returned once in `ingestUrl`; never recoverable after). Sent with
   * idempotent=false so a transient failure is never blind-retried (no accidental duplicate).
   */
  endpointsCreate(input: { name: string }): Promise<CreatedEndpoint>;
  /**
   * Soft-delete an endpoint (`DELETE /v1/endpoints/:id`). Idempotent — a re-delete returns the recorded
   * deletedAt, an unknown id is NOT_FOUND. The ingest URL stops accepting events; captured events remain.
   */
  endpointsDelete(endpointId: string): Promise<DeletedEndpoint>;
  /**
   * Rotate an endpoint's ingest URL (`POST /v1/endpoints/:id/rotate`). NOT idempotent — mints a fresh
   * one-time `ingestUrl` and immediately kills the old one (hard cutover). Sent with idempotent=false so
   * a transient failure is never blind-retried (no accidental second rotation).
   */
  endpointsRotate(endpointId: string): Promise<CreatedEndpoint>;
  /**
   * Register a provider signing secret on an endpoint (`POST /v1/endpoints/:id/provider-secrets`). The
   * plaintext `secret` is sealed server-side and NEVER returned. NOT idempotent — each call adds a
   * secret; sent with idempotent=false so a transient failure is never blind-retried.
   */
  addProviderSecret(input: {
    endpointId: string;
    provider: Provider;
    secret: string;
    label?: string;
  }): Promise<AddedProviderSecret>;
  /**
   * An endpoint's provider secrets as METADATA (`GET /v1/endpoints/:id/provider-secrets`). Not
   * paginated — a human-managed handful per endpoint, so the whole set is returned at once.
   */
  listProviderSecrets(endpointId: string): Promise<readonly ProviderSecretSummary[]>;
  /** Revoke a provider secret (`DELETE /v1/endpoints/:id/provider-secrets/:secretId`). */
  revokeProviderSecret(input: {
    endpointId: string;
    secretId: string;
  }): Promise<RevokedProviderSecret>;
  /** A page of an endpoint's captured events (`GET /v1/endpoints/:id/events`). */
  eventsList(endpointId: string, params?: EventsListParams): Promise<Page<EventSummary>>;
  /** A single event in full fidelity by id (`GET /v1/events/:id`). */
  eventsGet(eventId: string): Promise<Event>;
  /** The captured event's raw body bytes (`GET /v1/events/:id/payload` → base64 envelope, decoded). */
  eventsGetPayload(eventId: string): Promise<{ contentType: string | null; body: Uint8Array }>;
  /** Verify the org's tamper-evident audit chain (`POST /v1/audit/verify`). */
  auditVerify(): Promise<AuditVerifyResult>;
  /** Record a replay-to-localhost delivery attempt (`POST /v1/events/:id/replay`) — idempotent. */
  eventsReplay(input: {
    eventId: string;
    target: Target;
    idempotencyKey: string;
  }): Promise<DeliveryAttempt>;
}

export interface ApiClientDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injected fetch (the Workers/undici global in production; a fake in tests). */
  readonly fetch: typeof fetch;
  /** Backoff sleep between retries (real `setTimeout` in prod; instant under test). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source for the retry backoff (`Math.random` in prod; deterministic under test). */
  readonly rand?: () => number;
  /** Total attempts per request before surfacing the failure (default `API_MAX_ATTEMPTS`). */
  readonly maxAttempts?: number;
  /** The per-request timeout signal (default `AbortSignal.timeout(API_TIMEOUT_MS)`; injectable for tests). */
  readonly timeoutSignal?: () => AbortSignal;
  /**
   * Reactive auth hook for an OAuth credential: invoked AT MOST ONCE per request on a `401`, it returns a
   * fresh bearer (the rotated access token) to retry with, or `null` to give up (→ surface the 401). It may
   * throw an `OAuthError` (a dead refresh) which propagates → re-login. Absent for an api-key credential
   * (a 401 then surfaces immediately, no retry). The single-flight + persist live in the token manager.
   */
  readonly refreshAuth?: () => Promise<string | null>;
}

/** Append a query string from the defined params only (absent keys are omitted, never sent as empty). */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const maxAttempts = deps.maxAttempts ?? API_MAX_ATTEMPTS;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rand = deps.rand ?? Math.random;
  const makeTimeoutSignal = deps.timeoutSignal ?? (() => AbortSignal.timeout(API_TIMEOUT_MS));

  // Each request gets a wall-clock timeout and a bounded, jittered retry — but retries are gated to
  // IDEMPOTENT requests (a GET, or a POST that is a read / carries an idempotency key) AND to transient
  // failures (a throttle/gateway/unavailable/timeout or a transport error). A 4xx other than 429, or a
  // non-idempotent request, is never retried — so a replay can't be double-delivered by a blind retry.
  async function request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    opts: { body?: unknown; idempotent: boolean },
  ): Promise<unknown> {
    // The live bearer — mutated when the reactive refresh hook hands back a rotated access token. A 401
    // refresh+retry is safe for ANY method (a 401 means the request was rejected, never processed), so it
    // is NOT gated on idempotency; but it fires at most once per request (a second 401 surfaces the error).
    let bearer = deps.apiKey;
    let refreshedThisRequest = false;
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= maxAttempts;
      let res: Response;
      try {
        res = await deps.fetch(`${deps.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: makeTimeoutSignal(),
        });
      } catch {
        // A transport failure (DNS/TLS/connection) or a per-request timeout (the signal aborted). The
        // cause is omitted so a raw error string can't carry anything sensitive into output.
        if (opts.idempotent && !last) {
          await sleep(apiBackoffMs(attempt, rand));
          continue;
        }
        throw new ApiError(undefined, `could not reach the api at ${deps.baseUrl}`);
      }
      if (res.ok) return res.json();
      // An expired/just-rotated OAuth access token → one silent refresh + retry (an OAuthError from the
      // hook, e.g. a dead refresh, propagates → re-login). No attempt/backoff is consumed by the refresh.
      if (res.status === 401 && deps.refreshAuth !== undefined && !refreshedThisRequest) {
        refreshedThisRequest = true;
        const next = await deps.refreshAuth();
        if (next !== null) {
          bearer = next;
          attempt -= 1; // the refreshed retry is a fresh request, not a spent attempt
          continue;
        }
      }
      if (opts.idempotent && !last && isRetryableStatus(res.status)) {
        // Honour a delta-seconds `Retry-After` (clamped); otherwise fall back to jittered backoff.
        await sleep(parseRetryAfter(res.headers.get("retry-after")) ?? apiBackoffMs(attempt, rand));
        continue;
      }
      throw errorForStatus(res.status);
    }
  }

  const getJson = (path: string): Promise<unknown> => request(path, "GET", { idempotent: true });
  const postJson = (path: string, body: unknown, idempotent: boolean): Promise<unknown> =>
    request(path, "POST", { body, idempotent });
  // DELETE defaults to idempotent (endpoints.delete coalesces a re-delete to the recorded deletedAt, so
  // a blind retry is safe). The caller passes idempotent=false where the server handler is NOT idempotent
  // — e.g. revokeProviderSecret, where a re-revoke returns NOT_FOUND, so a blind retry after a lost
  // response would surface a false "not found" for a revoke that actually committed.
  const deleteJson = (path: string, idempotent = true): Promise<unknown> =>
    request(path, "DELETE", { idempotent });

  // Parse a response against its shared contract schema; an unexpected shape is UNEXPECTED (never a
  // capability code), so a server/version skew surfaces as "unexpected response", not a misleading 4xx.
  function parseOrThrow<S extends z.ZodTypeAny>(
    schema: S,
    body: unknown,
    what: string,
  ): z.infer<S> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(undefined, `the api returned an unexpected ${what} response`);
    }
    return parsed.data;
  }

  return {
    async whoami(): Promise<AuthContext> {
      return parseOrThrow(AuthContextSchema, await getJson("/v1/whoami"), "identity");
    },
    async endpointsList(params = {}): Promise<Page<Endpoint>> {
      const path = withQuery("/v1/endpoints", {
        cursor: params.cursor,
        limit: params.limit,
        name: params.name,
      });
      return parseOrThrow(endpointsListCap.output, await getJson(path), "endpoints");
    },
    async endpointsGet(endpointId): Promise<Endpoint> {
      const path = `/v1/endpoints/${encodeURIComponent(endpointId)}`;
      return parseOrThrow(endpointsGetCap.output, await getJson(path), "endpoint");
    },
    async endpointsCreate(input): Promise<CreatedEndpoint> {
      // idempotent=false: a create is not safe to blind-retry (it would mint a duplicate endpoint).
      const json = await postJson("/v1/endpoints", { name: input.name }, false);
      return parseOrThrow(endpointsCreateCap.output, json, "endpoint");
    },
    async endpointsDelete(endpointId): Promise<DeletedEndpoint> {
      const path = `/v1/endpoints/${encodeURIComponent(endpointId)}`;
      return parseOrThrow(endpointsDeleteCap.output, await deleteJson(path), "deleted endpoint");
    },
    async endpointsRotate(endpointId): Promise<CreatedEndpoint> {
      // idempotent=false: rotate mints a new token; a blind retry would rotate again (a second cutover).
      const path = `/v1/endpoints/${encodeURIComponent(endpointId)}/rotate`;
      const json = await postJson(path, undefined, false);
      return parseOrThrow(endpointsRotateCap.output, json, "rotated endpoint");
    },
    async addProviderSecret(input): Promise<AddedProviderSecret> {
      // idempotent=false: each call registers a new secret; a blind retry would add a duplicate.
      const path = `/v1/endpoints/${encodeURIComponent(input.endpointId)}/provider-secrets`;
      const body: Record<string, unknown> = { provider: input.provider, secret: input.secret };
      if (input.label !== undefined) body.label = input.label;
      const json = await postJson(path, body, false);
      return parseOrThrow(endpointsAddProviderSecretCap.output, json, "provider secret");
    },
    async listProviderSecrets(endpointId): Promise<readonly ProviderSecretSummary[]> {
      const path = `/v1/endpoints/${encodeURIComponent(endpointId)}/provider-secrets`;
      const { items } = parseOrThrow(
        endpointsListProviderSecretsCap.output,
        await getJson(path),
        "provider secrets",
      );
      return items;
    },
    async revokeProviderSecret(input): Promise<RevokedProviderSecret> {
      const path = `/v1/endpoints/${encodeURIComponent(input.endpointId)}/provider-secrets/${encodeURIComponent(input.secretId)}`;
      // idempotent=false: the server revoke is NOT idempotent (a re-revoke is NOT_FOUND), so never
      // blind-retry — a retry after a lost response would report a false "not found" for a committed revoke.
      return parseOrThrow(
        endpointsRevokeProviderSecretCap.output,
        await deleteJson(path, false),
        "revoked secret",
      );
    },
    async eventsList(endpointId, params = {}): Promise<Page<EventSummary>> {
      const path = withQuery(`/v1/endpoints/${encodeURIComponent(endpointId)}/events`, {
        cursor: params.cursor,
        limit: params.limit,
        provider: params.provider,
        receivedAfter: params.receivedAfter,
        receivedBefore: params.receivedBefore,
        verificationState: params.verificationState,
      });
      return parseOrThrow(eventsListCap.output, await getJson(path), "events");
    },
    async eventsGet(eventId): Promise<Event> {
      const path = `/v1/events/${encodeURIComponent(eventId)}`;
      return parseOrThrow(eventsGetCap.output, await getJson(path), "event");
    },
    async eventsReplay(input): Promise<DeliveryAttempt> {
      const path = `/v1/events/${encodeURIComponent(input.eventId)}/replay`;
      const json = await postJson(
        path,
        { target: input.target, idempotencyKey: input.idempotencyKey },
        true, // idempotency-keyed → safe to retry a transient failure
      );
      return parseOrThrow(eventsReplayCap.output, json, "replay");
    },
    async eventsGetPayload(eventId): Promise<{ contentType: string | null; body: Uint8Array }> {
      const path = `/v1/events/${encodeURIComponent(eventId)}/payload`;
      const env = parseOrThrow(eventsGetPayloadCap.output, await getJson(path), "payload");
      // Decode the base64 envelope back to exact bytes (the wire shape is JSON; see ADR-0015), then
      // cross-check the decoded length against the envelope's `bytes` — a truncated/corrupted body
      // surfaces as an explicit UNEXPECTED error, never a silently short payload handed to a replay.
      const body = b64ToBytes(env.bodyBase64);
      if (body.byteLength !== env.bytes) {
        throw new ApiError(undefined, "the api returned a corrupted payload response");
      }
      return { contentType: env.contentType, body };
    },
    async auditVerify(): Promise<AuditVerifyResult> {
      // A read (verifies the chain, no mutation) → safe to retry a transient failure.
      const json = await postJson("/v1/audit/verify", undefined, true);
      return parseOrThrow(auditVerifyCap.output, json, "audit");
    },
  };
}

/** Loopback hosts where plaintext http:// is acceptable (local dev / self-host on the same machine). */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Resolve the API base URL: `--api-url` flag › `WBHK_API_URL` env › stored profile value › default.
 * The resolved URL is the destination for the bearer API key, so it MUST be https:// — http:// is
 * rejected except for loopback dev — otherwise an override (or a tampered stored value) could downgrade
 * to plaintext or redirect the live credential to an attacker-chosen host. The value must be a clean
 * origin (no query/fragment); the NORMALIZED origin+path is returned (validating the parsed URL then
 * concatenating the raw string would let a query/whitespace value produce a malformed request target).
 * Anything else throws InvalidApiUrlError — so a persisted base URL is re-validated on every read.
 */
/** A short, bounded budget for the `doctor` reachability probe — never the full 30s request timeout. */
export const DOCTOR_PROBE_TIMEOUT_MS = 5_000;

/** What a `doctor` reachability probe learns about the API origin (no auth, no body parsing). */
export interface ReachabilityProbe {
  readonly reachable: boolean;
  readonly status?: number;
  /** The server's `Date` header (for clock-skew detection), when present + parseable. */
  readonly serverDate?: Date;
}

/**
 * Probe whether the API origin answers at all (the `doctor` health check) — a single bounded GET to the
 * base URL. ANY HTTP response counts as reachable (even a 404 root); only a transport/timeout error is
 * "unreachable". No credential is sent and no body is read; the `Date` header is captured for clock-skew.
 */
export async function probeReachability(opts: {
  fetch: typeof fetch;
  baseUrl: string;
  timeoutSignal?: () => AbortSignal;
}): Promise<ReachabilityProbe> {
  const signal = (opts.timeoutSignal ?? (() => AbortSignal.timeout(DOCTOR_PROBE_TIMEOUT_MS)))();
  try {
    const res = await opts.fetch(opts.baseUrl, { method: "GET", signal });
    const dateHeader = res.headers.get("date");
    const parsed = dateHeader !== null ? new Date(dateHeader) : undefined;
    const serverDate = parsed !== undefined && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
    return { reachable: true, status: res.status, serverDate };
  } catch {
    return { reachable: false };
  }
}

export function resolveApiBaseUrl(opts: { flag?: string; env?: string; stored?: string }): string {
  const raw = opts.flag ?? opts.env ?? opts.stored ?? DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidApiUrlError(raw);
  }
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttpOk) throw new InvalidApiUrlError(raw);
  // A base URL carries no query/fragment; reject rather than silently mangle `${base}/v1/…`.
  if (url.search !== "" || url.hash !== "") throw new InvalidApiUrlError(raw);
  // Return the normalized origin+path (drops whitespace; strips a trailing slash) so concatenation is safe.
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * Resolve the listen-tunnel base URL: `--tunnel-url` flag › `WBHK_TUNNEL_URL` env › stored › default.
 * The bearer api key rides the tunnel UPGRADE handshake, so the URL MUST be wss:// — ws:// is rejected
 * except for loopback dev — otherwise an override (or a tampered stored value) could downgrade to
 * plaintext or redirect the live credential to an attacker-chosen host. No query/fragment (would mangle
 * `${base}/listen`); the normalized origin+path is returned. Re-validated on every read.
 */
export function resolveTunnelUrl(opts: { flag?: string; env?: string; stored?: string }): string {
  const raw = opts.flag ?? opts.env ?? opts.stored ?? DEFAULT_TUNNEL_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidTunnelUrlError(raw);
  }
  const loopbackWsOk = url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "wss:" && !loopbackWsOk) throw new InvalidTunnelUrlError(raw);
  if (url.search !== "" || url.hash !== "") throw new InvalidTunnelUrlError(raw);
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * Resolve the web dashboard origin (`WBHK_DASHBOARD_URL` env › default), the base the in-tail TUI's `o`
 * key opens an event in. https-only (loopback http allowed for dev); no query/fragment. Mirrors the api
 * base-URL validation so a tampered override can't redirect the browser to a plaintext or hostile origin.
 */
export function resolveDashboardUrl(opts: { env?: string }): string {
  const raw = opts.env ?? DEFAULT_DASHBOARD_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidApiUrlError(raw);
  }
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttpOk) throw new InvalidApiUrlError(raw);
  if (url.search !== "" || url.hash !== "") throw new InvalidApiUrlError(raw);
  return (url.origin + url.pathname).replace(/\/+$/, "");
}
