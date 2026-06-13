// The concrete verifyBearer for the API-key path (§0.8). Surfaces (api/mcp) depend on
// the contract's VerifyBearer seam, NOT on this implementation directly — this is the
// one place api keys (today) and OAuth tokens (later) get wired behind the same call.
//
// It composes the pieces this package already owns:
//   * a CredentialResolver (KV hot path + webhook_authn cold path) -> {orgId, scopes,
//     audience},
//   * the contract's assertAudience (RFC 8707 audience binding),
// and yields the contract's AuthContext. The 401-vs-403 distinction is the surface's
// job (unauthenticated -> 401; authenticated-but-under-scoped -> 403); this layer throws
// a typed UnauthenticatedError on no/garbage credential and AudienceMismatchError on a
// resource mismatch, and the helper `requireScope` below gives surfaces the 403 path.

import { assertAudience, type AuthContext } from "@webhook-co/contract";

import type { CredentialResolver } from "./credential-resolver";

/** Thrown when no credential resolves (no such key / revoked / expired) -> surface 401. */
export class UnauthenticatedError extends Error {
  constructor(message = "no valid credential") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** Thrown when an authenticated principal lacks a required scope -> surface 403. */
export class InsufficientScopeError extends Error {
  constructor(public readonly requiredScope: string) {
    super(`missing required scope: ${requiredScope}`);
    this.name = "InsufficientScopeError";
  }
}

/**
 * Build a verifyBearer over a resolver. Returns a function matching the contract's
 * VerifyBearer type: (token, audience) => Promise<AuthContext>. It resolves the token to
 * a principal, enforces audience binding, and returns the AuthContext. Throws
 * UnauthenticatedError (no principal) or AudienceMismatchError (wrong resource).
 */
export function makeVerifyBearer(resolver: CredentialResolver) {
  return async function verifyBearer(token: string, audience: string): Promise<AuthContext> {
    const principal = await resolver.resolve(token);
    if (principal === null) {
      throw new UnauthenticatedError();
    }
    // RFC 8707: a credential minted for one resource must not be replayable at another.
    assertAudience(principal.audience, audience);
    return { orgId: principal.orgId, scopes: principal.scopes };
  };
}

/**
 * Enforce that an AuthContext carries `scope`, throwing InsufficientScopeError (-> 403)
 * if not. This is the authenticated-but-under-scoped path, distinct from the
 * unauthenticated (401) path in makeVerifyBearer. Surfaces call this per capability.
 */
export function requireScope(ctx: AuthContext, scope: string): void {
  if (!ctx.scopes.includes(scope)) {
    throw new InsufficientScopeError(scope);
  }
}
