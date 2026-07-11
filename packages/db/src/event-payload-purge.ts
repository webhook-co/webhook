// The DAL for the per-event R2 payload purge queue (S3, migration 0058). A tombstoned event's captured
// content is redacted in-tx, but its BODY lives in R2 and must be deleted asynchronously — the engine is the
// sole R2-delete principal, so the delete can't happen in the api/web/mcp tx that tombstoned the event.
// These are the thin real-SQL seams the engine's purge cron wires (the pure drain lives in apps/engine).
//
// Runs as `webhook_purge` on its OWN connection (NOT withTenant) — the role-targeted `FOR SELECT/UPDATE TO
// webhook_purge` policies are the sole bound, a bare cross-org read + column-scoped completion write. Mirrors
// the org_deletions purge DAL (org-lifecycle.ts).

import type { Sql } from "./client";

/** One tombstoned event whose R2 body must be purged. The endpoint + key fence the delete before it runs. */
export interface EventPurgeJob {
  readonly eventId: string;
  readonly orgId: string;
  /** Fences the stored R2 key to `org/{orgId}/ep/{endpointId}/` before the delete (readPayloadKey, H1). */
  readonly endpointId: string;
  readonly r2Key: string;
}

/**
 * Read outstanding event-payload purge jobs, oldest-first, for the engine drain. The partial index on
 * `(requested_at) where status='purging'` keeps the scan index-driven.
 */
export async function claimEventPurgeJobs(purge: Sql, limit: number): Promise<EventPurgeJob[]> {
  return purge<EventPurgeJob[]>`
    select event_id as "eventId", org_id as "orgId", endpoint_id as "endpointId",
           payload_r2_key as "r2Key"
    from event_payload_purge
    where status = 'purging'
    order by requested_at
    limit ${limit}`;
}

/**
 * Mark a purge job completed after its R2 object was deleted — its durable proof the body is gone. The
 * `status='purging'` predicate + the role-targeted UPDATE policy mean a completed job is never touched
 * again (idempotent under a crash-retry). Deliberately NOT a row delete: the completed job is evidence a
 * purge ran, and the retention prune later hard-deletes the tombstone row itself.
 */
export async function completeEventPurgeJob(purge: Sql, eventId: string): Promise<void> {
  await purge`
    update event_payload_purge
    set status = 'completed', purge_completed_at = now()
    where event_id = ${eventId} and status = 'purging'`;
}
