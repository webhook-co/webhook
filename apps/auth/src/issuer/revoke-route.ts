// A2b-4b — the pure HTTP contract of the frozen /revoke endpoint (RFC 7009 token revocation; the
// CLI-logout path, Lane D §10.5). Parse the urlencoded body, discriminate the presented token by PREFIX
// (whk_ access key vs rtk_ refresh handle), resolve its grant via the injected seams, and revoke-and-evict.
// I/O-free: the resolution / revokeGrant cascade / KV_AUTHZ eviction live in the deps (revoke-deps), so
// this contract is unit-testable and the mount (issuer-handler) stays thin.
//
// RFC 7009 §2.2: the endpoint responds 200 for ANY well-formed token request regardless of whether the
// token was valid, known, or already revoked — never leaking token state. The only error is a malformed
// request (a missing `token` → invalid_request). The cascade is idempotent, so a re-presented or unknown
// token is a safe no-op.

const ACCESS_PREFIX = "whk_";
const REFRESH_PREFIX = "rtk_";

// A /revoke body is one token + an optional hint. Cap it as defense in depth on this unauthenticated,
// DB-touching endpoint (alongside the edge rate-limit).
const MAX_BODY_BYTES = 2048;

export interface RevokeDeps {
  /** whk_ access key → its grant (cross-org by hash), or null if unknown / standalone. */
  resolveAccessTokenGrant: (token: string) => Promise<{ orgId: string; grantId: string } | null>;
  /** rtk_ refresh handle → its grant (org parsed from the handle), or null if unknown. */
  resolveRefreshTokenGrant: (token: string) => Promise<{ orgId: string; grantId: string } | null>;
  /** Revoke the grant (cascade api_keys + refresh handles) and evict the KV_AUTHZ principal cache. */
  revokeGrantAndEvict: (orgId: string, grantId: string) => Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** RFC 7009 success: 200, empty body, no-store. */
function ok(): Response {
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

/** A 400 invalid_request (no-store) — the only error shape /revoke emits (never leaks token state). */
function badRequest(description: string): Response {
  return new Response(
    JSON.stringify({ error: "invalid_request", error_description: description }),
    {
      status: 400,
      headers: { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" },
    },
  );
}

export async function handleRevokeRequest(deps: RevokeDeps, request: Request): Promise<Response> {
  const raw = await request.text();
  // Measure the UTF-8 BYTE length (not `.length`, which counts UTF-16 code units) so a multibyte body
  // can't slip past a cap intended in bytes.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return badRequest("request body too large");
  }
  const params = new URLSearchParams(raw);
  const token = params.get("token");
  if (!token) {
    return badRequest("token is required");
  }

  // Discriminate by the token's own prefix (authoritative); token_type_hint is advisory and ignored.
  // A token of neither shape (e.g. a provider opaque token, or garbage) resolves to no grant → 200 no-op.
  const grant = token.startsWith(ACCESS_PREFIX)
    ? await deps.resolveAccessTokenGrant(token)
    : token.startsWith(REFRESH_PREFIX)
      ? await deps.resolveRefreshTokenGrant(token)
      : null;

  if (grant) {
    await deps.revokeGrantAndEvict(grant.orgId, grant.grantId);
    deps.log?.("issuer.revoke.grant_revoked", { orgId: grant.orgId, grantId: grant.grantId });
  } else {
    // Unknown / spent / foreign token — RFC 7009 still returns 200; log without any token material.
    deps.log?.("issuer.revoke.no_grant", {});
  }
  return ok();
}
