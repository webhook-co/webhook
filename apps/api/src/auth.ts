// The REST API's auth surface. It binds to the CONTRACT seam (VerifyBearer, AuthContext,
// the RFC 9728 PRM / RFC 6750 challenge builders) and NEVER imports the api-key
// implementation directly — verifyBearer is injected so api keys today and OAuth tokens
// tomorrow share this exact call site. The implementation lives in @webhook-co/db
// (makeVerifyBearer over the credential resolver); this surface only knows the seam.

import {
  buildWwwAuthenticate,
  CAPABILITY_REGISTRY,
  type AuthContext,
  type VerifyBearer,
} from "@webhook-co/contract";

/** Outcome of authorizing a request for a specific capability. */
export type AuthzResult =
  | { readonly ok: true; readonly ctx: AuthContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly challenge: string };

export interface ApiAuthDeps {
  /** The contract seam. Injected — the surface never constructs the impl. */
  readonly verifyBearer: VerifyBearer;
  /** This resource's identifier (RFC 8707 audience the token must be bound to). */
  readonly resource: string;
  /** Absolute URL of the /.well-known/oauth-protected-resource document (RFC 9728). */
  readonly resourceMetadataUrl: string;
}

/** Pull a Bearer token out of the Authorization header, or null if absent/malformed. */
export function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Authorize a request to invoke `capabilityName`. Resolves the bearer token to an
 * AuthContext via the seam, enforces audience binding (inside verifyBearer), then checks
 * the capability's required scope. Returns a typed result the handler turns into a
 * response: 401 (no/invalid credential or wrong audience) vs 403 (authenticated but
 * under-scoped) — the RFC 6750 distinction.
 */
export async function authorize(
  deps: ApiAuthDeps,
  req: Request,
  capabilityName: string,
): Promise<AuthzResult> {
  const capability = CAPABILITY_REGISTRY.get(capabilityName);
  if (!capability) {
    // An unknown capability is a programming error, not a client one — fail closed.
    throw new Error(`unknown capability: ${capabilityName}`);
  }

  const token = extractBearer(req);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a null PRESENCE check, not a secret compare; the real compare is the constant-time hash in @webhook-co/db
  if (token === null) {
    return unauthenticated(deps);
  }

  let ctx: AuthContext;
  try {
    ctx = await deps.verifyBearer(token, deps.resource);
  } catch {
    // No principal, or an audience mismatch (replayed token) — both are 401. We do NOT
    // leak which: an attacker shouldn't learn whether a token is valid-but-misdirected.
    return unauthenticated(deps);
  }

  const required = capability.auth.scope;
  if (!ctx.scopes.includes(required)) {
    // Authenticated but under-scoped -> 403 insufficient_scope (RFC 6750).
    return {
      ok: false,
      status: 403,
      challenge: buildWwwAuthenticate(deps.resourceMetadataUrl, "insufficient_scope"),
    };
  }

  return { ok: true, ctx };
}

function unauthenticated(deps: ApiAuthDeps): AuthzResult {
  return {
    ok: false,
    status: 401,
    challenge: buildWwwAuthenticate(deps.resourceMetadataUrl, "invalid_token"),
  };
}
