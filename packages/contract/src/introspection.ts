// The frozen auth.↔mcp token-introspection contract (RFC 7662-shaped). auth.'s IssuerIntrospect
// WorkerEntrypoint returns an IntrospectionResult; mcp (the resource server) calls it over a service
// binding to validate any bearer it didn't mint — an opaque provider token, which is KV-bound to the
// auth. Worker so mcp can't validate it locally — then audience-binds the result to its own resource.
//
// This lives in @webhook-co/contract (not in either app) because it is the single source of truth both
// sides depend on: the auth. handler shapes it, the mcp client parses it, against ONE definition.

export interface IntrospectionResult {
  /** Whether the token is currently valid (RFC 7662 `active`). False = unknown/invalid/expired. */
  active: boolean;
  /** The principal's org — present only when `active` (RFC 7662 §2.2: never leak attributes for an inactive token). */
  orgId?: string;
  /** Pseudonymous user id of the principal, when a user is present. */
  userId?: string;
  /** The token's granted capability scopes. */
  scopes?: string[];
  /**
   * The RFC 8707 audience(s) the token is bound to — surfaced FAITHFULLY (a token minted for multiple
   * resources reports all of them), so the caller can apply its own binding policy. The caller MUST
   * re-check this against its own resource; collapsing a multi-value audience to one element would let a
   * token bound to several resources pass a single-resource check it shouldn't (cross-resource replay).
   */
  audience?: string | string[];
  /** Unix seconds (the issuer's unit), informational for the caller's cache TTL. */
  expiresAt?: number;
}

/**
 * The introspection RPC seam — a Cloudflare service-binding entrypoint on auth. (IssuerIntrospect). mcp
 * types its `env.<binding>` against this so the cross-Worker call site is checked against the contract.
 */
export interface TokenIntrospector {
  introspect(token: string): Promise<IntrospectionResult>;
}
