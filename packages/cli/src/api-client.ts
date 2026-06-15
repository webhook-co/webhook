import {
  AuthContextSchema,
  auditVerify as auditVerifyCap,
  endpointsGet as endpointsGetCap,
  endpointsList as endpointsListCap,
  eventsGet as eventsGetCap,
  eventsList as eventsListCap,
  type AuthContext,
  type CapabilityError,
} from "@webhook-co/contract";
import type { Endpoint, Event, EventSummary } from "@webhook-co/shared";
import type { z } from "zod";

import { CliError, InvalidApiUrlError } from "./errors.js";
import { EXIT, exitCodeForCapabilityError } from "./output/exit-codes.js";

// The CLI's Bearer HTTP client for the webhook.co REST API (api.webhook.co). It attaches the API key
// as `Authorization: Bearer …`, maps an HTTP status back to the closed CapabilityError taxonomy (the
// inverse of apps/api's http-status map), and parses every response against the SHARED contract output
// schema for that capability — so the CLI can't drift from the server's shape. `fetch` is injected so
// the client + every command is node-tested with no network.

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

/** events.list adds an optional provider filter. */
export interface EventsListParams extends ListParams {
  readonly provider?: string;
}

/** The audit-chain verification result (the shared `audit.verify` output: ok + rowsVerified, or a break). */
export type AuditVerifyResult = z.infer<typeof auditVerifyCap.output>;

export interface ApiClient {
  /** Resolve the caller's own identity — validates the key (`GET /v1/whoami`). */
  whoami(): Promise<AuthContext>;
  /** A page of the org's endpoints (`GET /v1/endpoints`). */
  endpointsList(params?: ListParams): Promise<Page<Endpoint>>;
  /** A single endpoint by id (`GET /v1/endpoints/:id`). */
  endpointsGet(endpointId: string): Promise<Endpoint>;
  /** A page of an endpoint's captured events (`GET /v1/endpoints/:id/events`). */
  eventsList(endpointId: string, params?: EventsListParams): Promise<Page<EventSummary>>;
  /** A single event in full fidelity by id (`GET /v1/events/:id`). */
  eventsGet(eventId: string): Promise<Event>;
  /** Verify the org's tamper-evident audit chain (`POST /v1/audit/verify`). */
  auditVerify(): Promise<AuditVerifyResult>;
}

export interface ApiClientDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injected fetch (the Workers/undici global in production; a fake in tests). */
  readonly fetch: typeof fetch;
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
  async function request(path: string, method: "GET" | "POST"): Promise<unknown> {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}${path}`, {
        method,
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

  const getJson = (path: string): Promise<unknown> => request(path, "GET");
  const postJson = (path: string): Promise<unknown> => request(path, "POST");

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
      const path = withQuery("/v1/endpoints", { cursor: params.cursor, limit: params.limit });
      return parseOrThrow(endpointsListCap.output, await getJson(path), "endpoints");
    },
    async endpointsGet(endpointId): Promise<Endpoint> {
      const path = `/v1/endpoints/${encodeURIComponent(endpointId)}`;
      return parseOrThrow(endpointsGetCap.output, await getJson(path), "endpoint");
    },
    async eventsList(endpointId, params = {}): Promise<Page<EventSummary>> {
      const path = withQuery(`/v1/endpoints/${encodeURIComponent(endpointId)}/events`, {
        cursor: params.cursor,
        limit: params.limit,
        provider: params.provider,
      });
      return parseOrThrow(eventsListCap.output, await getJson(path), "events");
    },
    async eventsGet(eventId): Promise<Event> {
      const path = `/v1/events/${encodeURIComponent(eventId)}`;
      return parseOrThrow(eventsGetCap.output, await getJson(path), "event");
    },
    async auditVerify(): Promise<AuditVerifyResult> {
      return parseOrThrow(auditVerifyCap.output, await postJson("/v1/audit/verify"), "audit");
    },
  };
}

/** Loopback hosts where plaintext http:// is acceptable (local dev / self-host on the same machine). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Resolve the API base URL: `--api-url` flag › `WBHK_API_URL` env › stored profile value › default.
 * The resolved URL is the destination for the bearer API key, so it MUST be https:// — http:// is
 * rejected except for loopback dev — otherwise an override (or a tampered stored value) could downgrade
 * to plaintext or redirect the live credential to an attacker-chosen host. The value must be a clean
 * origin (no query/fragment); the NORMALIZED origin+path is returned (validating the parsed URL then
 * concatenating the raw string would let a query/whitespace value produce a malformed request target).
 * Anything else throws InvalidApiUrlError — so a persisted base URL is re-validated on every read.
 */
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
