// The auth seam every bearer surface depends on (§0.8) + the RFC 9728 resource-server
// obligations on mcp. Surfaces depend on AuthContext, never on Better Auth or the
// OAuth provider directly. The concrete verifyBearer (resolving API keys today, OAuth
// access tokens tomorrow) lands in the auth workstream; the freeze fixes the shapes
// and the audience-binding rule.

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
  const safeUrl = resourceMetadataUrl.replace(/["\\\r\n]/g, encodeURIComponent);
  const parts = [`Bearer resource_metadata="${safeUrl}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}
