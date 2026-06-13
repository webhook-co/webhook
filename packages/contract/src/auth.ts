// The auth seam every bearer surface depends on (§0.8) + the RFC 9728 resource-server
// obligations on mcp. Surfaces depend on AuthContext, never on Better Auth or the
// OAuth provider directly. The concrete verifyBearer (resolving API keys today, OAuth
// access tokens tomorrow) lands in the auth workstream; the freeze fixes the shapes
// and the audience-binding rule. The shared bearer-authorize decision (extract token ->
// verify -> scope -> 401/403) lives here too, so every surface binds ONE implementation.

import { CAPABILITY_REGISTRY } from "./capabilities";

export interface AuthContext {
  readonly orgId: string;
  /** Pseudonymous user id when a user principal is present (M1). */
  readonly userId?: string;
  readonly scopes: readonly string[];
}

/**
 * verifyBearer resolves a presented token to an AuthContext AND enforces audience
 * binding (RFC 8707/9728): a token minted for one resource must not be replayable at
 * another. Implementations MUST reject when the token's audience != `audience`.
 */
export type VerifyBearer = (token: string, audience: string) => Promise<AuthContext>;

export class AudienceMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`token audience ${actual ?? "<none>"} does not match resource ${expected}`);
    this.name = "AudienceMismatchError";
  }
}

/**
 * Thrown by a verifyBearer implementation when no credential resolves (no such key /
 * revoked / expired) — the "this request isn't authenticated" signal that maps to a 401.
 * It lives on the seam (not in the impl package) so authorizeBearer can distinguish an
 * EXPECTED auth rejection from an UNEXPECTED operational fault (a DB/KMS outage), which
 * must surface as a 5xx rather than be masqueraded as a 401.
 */
export class UnauthenticatedError extends Error {
  constructor(message = "no valid credential") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** The audience check verifyBearer must apply. Throws on mismatch (constant-ish). */
export function assertAudience(tokenAudience: string | undefined, expected: string): void {
  if (tokenAudience !== expected) {
    throw new AudienceMismatchError(expected, tokenAudience);
  }
}

/**
 * RFC 9728 protected-resource metadata, served at
 * /.well-known/oauth-protected-resource so an MCP client can discover the issuer(s)
 * and run dynamic client registration.
 */
export interface ProtectedResourceMetadata {
  /** The resource identifier (the audience tokens must be bound to). */
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
}

export function buildProtectedResourceMetadata(params: {
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly string[];
}): ProtectedResourceMetadata {
  return {
    resource: params.resource,
    authorization_servers: params.authorizationServers,
    bearer_methods_supported: ["header"],
    ...(params.scopesSupported ? { scopes_supported: params.scopesSupported } : {}),
  };
}

/** RFC 6750 error codes a resource server may return in the challenge. */
export type BearerError = "invalid_request" | "invalid_token" | "insufficient_scope";

/**
 * The WWW-Authenticate challenge a resource server returns on a 401, pointing the
 * client at its PRM document (RFC 9728). `resourceMetadataUrl` is the absolute URL of
 * the /.well-known/oauth-protected-resource document. Inputs are constrained/encoded so
 * a value can't break out of the header (no header injection): `error` is a fixed
 * RFC 6750 token and the URL is percent-encoded for any `"`/control characters.
 */
export function buildWwwAuthenticate(resourceMetadataUrl: string, error?: BearerError): string {
  // Percent-encode every character illegal in an HTTP header field-value: ALL C0
  // controls (incl. CR/LF/TAB), DEL, plus the quote and backslash that would break out
  // of the quoted-string — closing header-injection via any control character. Done by
  // char code (not a control-char regex) so the source stays free of raw control bytes.
  const safeUrl = [...resourceMetadataUrl]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0x1f || c === 0x7f || c === 0x22 || c === 0x5c ? encodeURIComponent(ch) : ch;
    })
    .join("");
  const parts = [`Bearer resource_metadata="${safeUrl}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

// ── Shared bearer-authorize decision ───────────────────────────────────────────────────
// Both the REST API and the MCP surface resolve a bearer token to an AuthContext and map
// the outcome to 401 (no/invalid credential or wrong audience) vs 403 (authenticated but
// under-scoped). That decision — and the token parsing — live here ONCE so the surfaces
// can't drift; each surface only shapes its deps and adapts its Request.

/** What a surface needs to authorize a bearer request. Both api and mcp deps satisfy it. */
export interface BearerAuthzDeps {
  /** The contract seam. Injected — surfaces never construct the impl. */
  readonly verifyBearer: VerifyBearer;
  /** This resource's identifier (RFC 8707 audience the token must be bound to). */
  readonly resource: string;
  /** Absolute URL of the /.well-known/oauth-protected-resource document (RFC 9728). */
  readonly resourceMetadataUrl: string;
}

/** The 401/403-or-ok outcome of authorizing a bearer request for a capability. */
export type BearerAuthzResult =
  | { readonly ok: true; readonly ctx: AuthContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly challenge: string };

/**
 * Pull a Bearer token from an Authorization header value, or null if absent/malformed.
 * Per RFC 6750 / 7235 the scheme is CASE-INSENSITIVE and 1*SP separates it from the token,
 * so "bearer  tok" and "BEARER tok" are accepted and the token is trimmed.
 */
export function extractBearer(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}

/**
 * The shared authorize decision: resolve the bearer token to an AuthContext (audience-bound
 * inside verifyBearer), then enforce the capability's required scope. Returns a typed result
 * the surface turns into a response. An EXPECTED auth rejection (UnauthenticatedError /
 * AudienceMismatchError) becomes a 401; any OTHER error (an operational fault — DB/KMS
 * outage, a bug) is RE-THROWN so it surfaces as a 5xx instead of being masqueraded as a 401.
 */
export async function authorizeBearer(
  deps: BearerAuthzDeps,
  authorizationHeader: string | null | undefined,
  capabilityName: string,
): Promise<BearerAuthzResult> {
  const capability = CAPABILITY_REGISTRY.get(capabilityName);
  if (!capability) {
    // An unknown capability is a programming error, not a client one — fail closed.
    throw new Error(`unknown capability: ${capabilityName}`);
  }

  const token = extractBearer(authorizationHeader);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a null PRESENCE check, not a secret compare; the real compare is the constant-time hash in @webhook-co/db
  if (token === null) {
    return bearerUnauthenticated(deps.resourceMetadataUrl);
  }

  let ctx: AuthContext;
  try {
    ctx = await deps.verifyBearer(token, deps.resource);
  } catch (err) {
    if (isExpectedAuthRejection(err)) {
      // No principal, or an audience mismatch (replayed token) — both are 401. We do NOT
      // leak which: an attacker shouldn't learn whether a token is valid-but-misdirected.
      return bearerUnauthenticated(deps.resourceMetadataUrl);
    }
    // Operational fault (DB/Hyperdrive/KMS outage, a bug) — never a silent 401. Propagate
    // so the surface's error boundary logs it and returns a 5xx.
    throw err;
  }

  if (!ctx.scopes.includes(capability.auth.scope)) {
    // Authenticated but under-scoped -> 403 insufficient_scope (RFC 6750).
    return {
      ok: false,
      status: 403,
      challenge: buildWwwAuthenticate(deps.resourceMetadataUrl, "insufficient_scope"),
    };
  }

  return { ok: true, ctx };
}

function bearerUnauthenticated(resourceMetadataUrl: string): BearerAuthzResult {
  return {
    ok: false,
    status: 401,
    challenge: buildWwwAuthenticate(resourceMetadataUrl, "invalid_token"),
  };
}

/**
 * The errors a verifyBearer implementation is allowed to throw for an ordinary
 * "not authenticated" outcome (-> 401). Anything else is operational and must propagate.
 */
function isExpectedAuthRejection(err: unknown): boolean {
  return err instanceof UnauthenticatedError || err instanceof AudienceMismatchError;
}
