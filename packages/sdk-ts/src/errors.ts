// The SDK's typed error surface. Every failure a caller can catch is a `WebhookError`; the subclasses
// let callers narrow by `instanceof` without string-matching a code. The taxonomy mirrors the API's
// three error representations (a JSON `{error,message}` envelope, an empty-body 401/403, and a text/plain
// router miss) — the HTTP core resolves those into one of these before throwing.

/** The closed set of capability-error codes the API can return (mirrors apps/api's http-status map). */
export type WebhookErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ENDPOINT_PAUSED"
  | "RATE_LIMITED"
  | "TARGET_UNREACHABLE";

/** HTTP status → capability code (the inverse of apps/api/src/http-status.ts). */
const STATUS_TO_CODE: Readonly<Record<number, WebhookErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "ENDPOINT_PAUSED",
  429: "RATE_LIMITED",
  502: "TARGET_UNREACHABLE",
};

/** A concise default message per code, used when the server sends no `message` (e.g. an empty-body 401). */
export const DEFAULT_MESSAGE: Readonly<Record<WebhookErrorCode, string>> = {
  UNAUTHORIZED: "authentication failed — the API key is invalid, expired, or revoked",
  FORBIDDEN: "the API key is missing a required scope for this action",
  NOT_FOUND: "the requested resource was not found",
  VALIDATION_ERROR: "the request was rejected as invalid",
  RATE_LIMITED: "rate limited — retry after a short delay",
  ENDPOINT_PAUSED: "the endpoint is paused",
  TARGET_UNREACHABLE: "the delivery target was unreachable",
};

/** Resolve the capability code for an HTTP status, or undefined when the status isn't modelled. */
export function codeForStatus(status: number): WebhookErrorCode | undefined {
  return STATUS_TO_CODE[status];
}

/** Fields shared by every SDK error. */
export interface WebhookErrorFields {
  readonly code?: WebhookErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
}

/** Base class for every error the SDK throws. Catch this to handle any SDK failure uniformly. */
export class WebhookError extends Error {
  readonly code?: WebhookErrorCode;
  /** The HTTP status, when the failure came from a server response. */
  readonly status?: number;
  /** The server's request id, when present (surface it in bug reports). */
  readonly requestId?: string;
  /** For a rate-limit error: the suggested wait before retrying, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, fields: WebhookErrorFields = {}) {
    super(message);
    this.name = new.target.name;
    this.code = fields.code;
    this.status = fields.status;
    this.requestId = fields.requestId;
    this.retryAfterMs = fields.retryAfterMs;
  }
}

/** The SDK was constructed with invalid options (e.g. a plaintext base URL). Thrown eagerly, before any request. */
export class WebhookConfigError extends WebhookError {}

/** The request never reached the server (DNS/TLS/connection failure or a client-side timeout). */
export class WebhookConnectionError extends WebhookError {}

/** The server returned an HTTP error response. Always carries a `status`. */
export class WebhookAPIError extends WebhookError {
  override readonly status: number;
  constructor(message: string, fields: WebhookErrorFields & { status: number }) {
    super(message, fields);
    this.status = fields.status;
  }
}

/** 401 — the credential is invalid, expired, or revoked. */
export class WebhookAuthenticationError extends WebhookAPIError {}
/** 403 — the credential lacks a scope required for the action. */
export class WebhookPermissionError extends WebhookAPIError {}
/** 404 — the resource does not exist (or is not visible to this org). */
export class WebhookNotFoundError extends WebhookAPIError {}
/** 400 — the request was structurally or semantically invalid. */
export class WebhookInvalidRequestError extends WebhookAPIError {}
/** 409 — the endpoint is paused (a conflicting state). */
export class WebhookConflictError extends WebhookAPIError {}
/** 429 — rate limited; inspect `retryAfterMs`. */
export class WebhookRateLimitError extends WebhookAPIError {}
/** 502 — the downstream delivery target was unreachable. */
export class WebhookTargetUnreachableError extends WebhookAPIError {}

/** A response the SDK can't interpret: an unmodelled error status, or a body that failed validation. */
export class WebhookUnexpectedResponseError extends WebhookError {}

/** code → the subclass that represents it. */
const CODE_TO_CTOR: Readonly<
  Record<
    WebhookErrorCode,
    new (message: string, fields: WebhookErrorFields & { status: number }) => WebhookAPIError
  >
> = {
  VALIDATION_ERROR: WebhookInvalidRequestError,
  UNAUTHORIZED: WebhookAuthenticationError,
  FORBIDDEN: WebhookPermissionError,
  NOT_FOUND: WebhookNotFoundError,
  ENDPOINT_PAUSED: WebhookConflictError,
  RATE_LIMITED: WebhookRateLimitError,
  TARGET_UNREACHABLE: WebhookTargetUnreachableError,
};

/** Inputs the HTTP core has already resolved from a failed response (message/code already redacted). */
export interface ResponseErrorInput {
  readonly status: number;
  /** The envelope's `error` code when the body carried one; authoritative over the status mapping. */
  readonly code?: WebhookErrorCode;
  /** The envelope's `message`, if any; falls back to the code's default message. */
  readonly message?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
}

/**
 * Build the typed error for a failed response. A body code (when present) wins over the status-derived
 * code; a modelled code selects its subclass; anything unmodelled becomes an unexpected-response error.
 */
export function errorFromResponse(input: ResponseErrorInput): WebhookError {
  const code = input.code ?? codeForStatus(input.status);
  const fields: WebhookErrorFields & { status: number } = {
    status: input.status,
    code,
    requestId: input.requestId,
    retryAfterMs: input.retryAfterMs,
  };
  if (code !== undefined) {
    const message = input.message ?? DEFAULT_MESSAGE[code];
    return new CODE_TO_CTOR[code](message, fields);
  }
  const message = input.message ?? `the API returned an unexpected response (HTTP ${input.status})`;
  return new WebhookUnexpectedResponseError(message, fields);
}

/** Build a connection error for a transport failure. The cause is omitted so no raw string can leak. */
export function errorFromTransport(baseUrl: string): WebhookConnectionError {
  return new WebhookConnectionError(`could not reach the API at ${baseUrl}`);
}
