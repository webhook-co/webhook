// The Workers-KV adapter for the credential resolver's hot cache. packages/db defines the
// CredentialCache seam (Node-only, never imports Workers types); this thin adapter, living in the
// Worker, binds it to a real KVNamespace. KV is the ONLY ingest cache because it can be invalidated
// on pause/rotate/delete — a revoke deletes the entry, so a revoked token stops resolving on the
// very next request. (Hyperdrive's query cache can't be invalidated, which is why the cold path runs
// through the cache-disabled binding instead.)

import type { CredentialCache } from "@webhook-co/db";

/**
 * Wrap a KVNamespace as a CredentialCache. Values are JSON strings of a ResolvedPrincipal (never the
 * plaintext credential; the key is the hash hex). `ttlSeconds` maps to KV's expirationTtl as a
 * staleness backstop — explicit invalidation (delete) is the primary freshness path.
 */
export function kvCredentialCache(kv: KVNamespace): CredentialCache {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttlSeconds) =>
      kv.put(key, value, ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : undefined),
    delete: (key) => kv.delete(key),
  };
}
