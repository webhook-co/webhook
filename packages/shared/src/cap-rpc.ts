// The web -> engine service-binding RPC contract for ingest-cache eviction (WS3, the overage toggle).
// Single-sourced here so the engine's IngestCacheEvictor (the producer) and the web consumer's binding type
// can't drift — same pattern as IngestUrlRevealerRpc / DeliveryDispatcherRpc.
//
// Division of labor (deliberate, for money-correctness): the web tier flips org_limits.pause_policy AND
// durably reconciles ingest_paused in ONE DB transaction (setOverageEnabled), so enforcement is correct the
// instant that commits. This RPC does ONLY the thing web can't: evict the org's ingest-token entries from
// the KV cache the ENGINE owns, so the flip is picked up on the next cold miss instead of at the cache TTL.
// It is therefore best-effort — a missing/failing eviction only delays cache freshness (TTL-backstopped),
// never leaves the durable enforcement state wrong.

/**
 * The narrow RPC surface the web tier calls over the service binding
 * (env.INGEST_CACHE_EVICTOR.evictOrgIngestCache). IDENTIFIER-only: the consumer passes the org id and the
 * engine reads that org's live endpoint token-hashes UNDER ITS RLS and deletes their cache entries — no
 * cross-org reach. Returns nothing; eviction is fire-and-forget from the caller's correctness standpoint.
 */
export interface IngestCacheEvictorRpc {
  evictOrgIngestCache(orgId: string): Promise<void>;
}
