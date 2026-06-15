import {
  AudienceMismatchError,
  UnauthenticatedError,
  type VerifyBearer,
} from "@webhook-co/contract";

// The API-key bridge for the OAuthProvider's `resolveExternalToken` hook. The provider calls it
// for any bearer it didn't mint itself (i.e. NOT one of its own opaque KV tokens) — which today is
// every caller, since the OAuth /authorize login that mints provider tokens is deferred (ADR-0010).
// We resolve the bearer as an API key through the SAME verifyBearer seam apps/api uses (audience =
// MCP_RESOURCE), and hand the provider the principal as grant props + the bound audience, so the
// provider's own RFC 8707 check re-validates it against the resource identity. The handler then
// exposes these props on ctx.props -> the McpAgent's this.props -> grantPropsToAuthContext.
//
// Pure + injected (verifyBearer + resource in) so the success / reject / operational paths are
// node-tested with no DB; index.ts wires the real verifyBearer (credential resolver + cold lookup)
// and owns the per-call client lifecycle.

export interface ExternalTokenDeps {
  /** The contract seam resolving an API key to an AuthContext (audience-bound inside). */
  readonly verifyBearer: VerifyBearer;
  /** This resource's RFC 8707 audience — the api keys must be bound to it. */
  readonly resource: string;
}

/** The grant props the provider stores + hands to the apiHandler (exactly the AuthContext shape). */
export interface ExternalTokenResult {
  readonly props: {
    readonly orgId: string;
    readonly userId?: string;
    readonly scopes: readonly string[];
  };
  readonly audience: string;
}

/**
 * Resolve an external (API-key) bearer to grant props, or `null` when it doesn't authenticate.
 * Mirrors the contract's authorizeBearer split: an EXPECTED auth rejection (no principal, or a
 * replayed token with the wrong audience) returns `null` (the provider answers 401); any OTHER
 * error is operational (DB/Hyperdrive outage, a bug) and is RE-THROWN so it surfaces as a 5xx
 * instead of being masqueraded as an auth failure.
 */
export async function resolveApiKeyToProps(
  deps: ExternalTokenDeps,
  token: string,
): Promise<ExternalTokenResult | null> {
  let ctx;
  try {
    ctx = await deps.verifyBearer(token, deps.resource);
  } catch (err) {
    if (err instanceof UnauthenticatedError || err instanceof AudienceMismatchError) {
      return null;
    }
    throw err;
  }
  return {
    props: {
      orgId: ctx.orgId,
      scopes: ctx.scopes,
      ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    },
    audience: deps.resource,
  };
}
