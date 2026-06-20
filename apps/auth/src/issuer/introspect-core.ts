// A2b-5 — the auth.→mcp token-introspection RPC core. RFC 7662-shaped, but an INTERNAL service-binding RPC
// (not the public HTTP endpoint): mcp (A8) calls it for any bearer it didn't mint — an opaque provider
// token, which is KV-bound to THIS Worker so mcp can't validate it locally — then audience-binds the result
// to MCP_RESOURCE. The provider's unwrapToken already returns null for unknown / invalid / EXPIRED tokens
// (oauth-provider.js: `expiresAt < now → null`), so this core just maps a successful unwrap to the result.
// I/O-free (the unwrap is an injected seam), so it's unit-testable; the getOAuthApi wiring is the handler.

export interface IntrospectionResult {
  active: boolean;
  orgId?: string;
  userId?: string;
  scopes?: string[];
  audience?: string;
  /** Unix seconds (the provider's unit), informational for the caller's cache TTL. */
  expiresAt?: number;
}

/** The fields the core needs from a successfully-unwrapped opaque token. */
export interface UnwrappedToken {
  orgId: string;
  userId: string;
  scopes: string[];
  audience?: string;
  expiresAt?: number;
}

export interface IntrospectDeps {
  /** Decrypt + validate the opaque token → its principal, or null (unknown / invalid / expired). */
  unwrapToken: (token: string) => Promise<UnwrappedToken | null>;
}

const INACTIVE: IntrospectionResult = { active: false };

/**
 * Introspect an opaque provider token. Returns `{active:false}` (and nothing else — never leak attributes
 * for an inactive token, RFC 7662 §2.2) for an empty / unknown / invalid / expired token; otherwise the
 * token's principal. The caller (mcp) must still check `audience` against its own resource.
 */
export async function introspectToken(
  deps: IntrospectDeps,
  token: string,
): Promise<IntrospectionResult> {
  if (!token) return INACTIVE;
  const t = await deps.unwrapToken(token);
  if (!t) return INACTIVE;
  return {
    active: true,
    orgId: t.orgId,
    userId: t.userId,
    scopes: t.scopes,
    audience: t.audience,
    expiresAt: t.expiresAt,
  };
}
