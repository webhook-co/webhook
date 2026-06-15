import { AuthContextSchema, type AuthContext, type CapabilityError } from "@webhook-co/contract";

import { CliError, InvalidApiUrlError } from "./errors.js";
import { EXIT, exitCodeForCapabilityError } from "./output/exit-codes.js";

// The CLI's Bearer HTTP client for the webhook.co REST API (api.webhook.co). It attaches the API key
// as `Authorization: Bearer …`, maps an HTTP status back to the closed CapabilityError taxonomy (the
// inverse of apps/api's http-status map), and parses responses against the shared contract schema.
// `fetch` is injected so the client + every command is node-tested with no network. Slice 9 ships
// `whoami()` (the identity/validate call) + the error+parse machinery; the read-capability methods
// reuse this client in Slice 10.

/** The canonical hosted API. Overridable via `--api-url` or `WBHK_API_URL` (self-host / dev). */
export const DEFAULT_API_BASE_URL = "https://api.webhook.co";

/** Env var overriding the API base URL (sticky alternative to the per-invocation `--api-url`). */
export const ENV_API_URL_VAR = "WBHK_API_URL";

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

export interface ApiClient {
  /** Resolve the caller's own identity — validates the key (`GET /v1/whoami`). */
  whoami(): Promise<AuthContext>;
}

export interface ApiClientDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injected fetch (the Workers/undici global in production; a fake in tests). */
  readonly fetch: typeof fetch;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  async function getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${deps.apiKey}`, accept: "application/json" },
      });
    } catch {
      // A transport failure (DNS/TLS/connection) — not a CapabilityError. The cause is omitted so a
      // raw error string can't carry anything sensitive into output; the base URL is safe to show.
      throw new ApiError(undefined, `could not reach the api at ${deps.baseUrl}`);
    }
    if (!res.ok) throw errorForStatus(res.status);
    return res.json();
  }

  return {
    async whoami(): Promise<AuthContext> {
      const parsed = AuthContextSchema.safeParse(await getJson("/v1/whoami"));
      if (!parsed.success) {
        throw new ApiError(undefined, "the api returned an unexpected identity response");
      }
      return parsed.data;
    },
  };
}

/** Loopback hosts where plaintext http:// is acceptable (local dev / self-host on the same machine). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Resolve the API base URL: `--api-url` flag › `WBHK_API_URL` env › default. (Persisting a per-profile
 * base URL is deferred — the credential store doesn't surface it yet; ADR-0012.) The resolved URL is
 * the destination for the bearer API key, so it MUST be https:// — http:// is rejected except for
 * loopback dev — otherwise an override could downgrade to plaintext or redirect the live credential to
 * an attacker-chosen host. The value must be a clean origin (no query/fragment); the NORMALIZED
 * origin+path is returned (validating the parsed URL then concatenating the raw string would let a
 * query/whitespace value produce a malformed request target). Anything else throws InvalidApiUrlError.
 */
export function resolveApiBaseUrl(opts: { flag?: string; env?: string }): string {
  const raw = opts.flag ?? opts.env ?? DEFAULT_API_BASE_URL;
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
