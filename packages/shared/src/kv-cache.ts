// The Workers-KV adapter for the credential resolver's hot cache, shared by every bearer
// Worker (engine ingest, api, mcp). It lives here — not in @webhook-co/db — because db is the
// Node-only package that defines the CredentialCache seam and must never import Workers types;
// db already depends on shared, so shared can't import db back (that's a cycle). This module is
// therefore reachable ONLY via the `@webhook-co/shared/kv-cache` subpath and is deliberately NOT
// re-exported from the package barrel, so db's node-typecheck of the barrel never sees KVNamespace.
//
// KV is the ONLY cache in the authn path because it can be invalidated on pause/rotate/delete: a
// revoke deletes the entry, so a revoked credential stops resolving on the very next request.
// (Hyperdrive's query cache can't be invalidated, which is why the cold lookup runs through the
// cache-disabled binding instead.)

/**
 * Structural match for @webhook-co/db's `CredentialCache`. Kept dependency-free (no db import)
 * so the consumer assigns the returned value straight into the db resolver, where structural
 * typing checks it against `CredentialCache`. Values are JSON strings of a ResolvedPrincipal
 * (never the plaintext credential; the key is the hash hex).
 */
export interface KvCredentialCacheLike {
  get(key: string): Promise<string | null>;
  /** ttlSeconds bounds staleness as a backstop; explicit delete is the primary invalidation. */
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Wrap a KVNamespace as a credential cache. `ttlSeconds` maps to KV's expirationTtl as a
 * staleness backstop; explicit invalidation (delete) is the primary freshness path.
 */
export function kvCredentialCache(kv: KVNamespace): KvCredentialCacheLike {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttlSeconds) =>
      kv.put(key, value, ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : undefined),
    delete: (key) => kv.delete(key),
  };
}
