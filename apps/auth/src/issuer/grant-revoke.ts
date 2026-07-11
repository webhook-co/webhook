// The grant-revoke cascade, in ONE place, with the ordering that matters.
//
// Revoking a grant has three effects, and they are NOT equally important:
//
//   1. `revokeGrant` — the DB commit. AUTHORITATIVE: it flips the grant + its child api_keys to revoked.
//   2. Evicting those keys from the shared principal cache (KV_AUTHZ). SECURITY-CRITICAL: api./mcp./engine
//      resolve a bearer from that cache, so until the entry is gone a revoked key KEEPS AUTHENTICATING for
//      the cache TTL. The DB commit is invisible to them until then.
//   3. `revokeRefreshTokensForGrant` — defense in depth only. The consume gate already refuses to refresh a
//      revoked grant (`g.status = 'active'`), so this merely tidies the handles.
//
// So (2) must not be able to be skipped by a failure in (3). Ordering it after the sweep — as the two
// call sites previously did independently — means one transient Postgres fault on the *tidying* write
// silently leaves a revoked credential live at the edge for the full cache TTL. Evict first, then sweep,
// and let neither best-effort step take the other down.

/** The slice of KV we need (structural — avoids a Workers-global lib dep in a pure module). */
export interface CacheEvicter {
  delete(key: string): Promise<void>;
}

export interface GrantRevokeCascadeDeps {
  /** Flip the grant + child keys to revoked; returns the child key hashes to evict. */
  revokeGrant: () => Promise<{ revokedKeyHashes: readonly Uint8Array[] }>;
  /** Kill the grant's refresh handles. Defense in depth — the consume gate already blocks a revoked grant. */
  revokeRefreshTokens: () => Promise<void>;
  cache: CacheEvicter;
  /** Map a key hash to the exact cache key the resolver writes (`credentialCacheKey`). */
  cacheKey: (keyHash: Uint8Array) => string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Revoke a grant and make that revocation visible everywhere, in the order that keeps it safe:
 * DB commit (authoritative) → cache eviction (security-critical) → refresh-handle sweep (tidying).
 *
 * The DB commit propagates on failure — a revoke that didn't commit must not look like it did. The eviction
 * and the sweep are best-effort and independently guarded: a KV fault self-heals at the cache TTL, and a
 * failed sweep cannot prevent the eviction, because the sweep is the least important of the three.
 */
export async function revokeGrantAndEvict(deps: GrantRevokeCascadeDeps): Promise<void> {
  const { revokedKeyHashes } = await deps.revokeGrant();

  // BEFORE the sweep: this is what actually stops the credential at api./mcp./engine.
  await Promise.all(
    revokedKeyHashes.map((keyHash) =>
      deps.cache
        .delete(deps.cacheKey(keyHash))
        .catch((error: unknown) =>
          deps.log?.("grant_revoke.kv_evict_failed", { error: String(error) }),
        ),
    ),
  );

  // Tidying only. Guarded, so it can never be the reason an eviction (above) or a revoke (already
  // committed) is lost.
  await deps
    .revokeRefreshTokens()
    .catch((error: unknown) =>
      deps.log?.("grant_revoke.refresh_sweep_failed", { error: String(error) }),
    );
}
