// The per-event R2 payload purge drain (S3). Pure + dependency-injected so it unit-tests with fakes; the
// engine's scheduled() handler wires the real deps (a webhook_purge cross-org connection that enumerates
// tombstoned events awaiting purge + marks them complete, and the R2_PAYLOADS bucket). The engine is the
// sole R2-delete principal, so this is where a user-deleted event's captured body is actually removed.
//
// A tombstone redacts the event's captured content in the delete tx and enqueues its R2 body here; this drain
// deletes the object and flips the job to `completed`. Ordering: fence the stored key to the org+endpoint
// prefix FIRST (a corrupt or cross-tenant key could otherwise destroy a victim's object), then delete R2,
// then mark complete — so a crash between the R2 delete and the completion write just re-runs a no-op delete
// (R2 delete is idempotent) rather than losing the job. Bounded per tick so a large backlog can't blow the
// Workers subrequest/CPU ceiling; the remainder resumes next tick.

/** One tombstoned event whose R2 body must be purged. */
export interface EventPurgeJob {
  readonly eventId: string;
  readonly orgId: string;
  readonly endpointId: string;
  readonly r2Key: string;
}

export interface EventPayloadPurgeCronDeps {
  /** Outstanding purge jobs, oldest-first, up to `limit` (webhook_purge cross-org read). */
  claim: (limit: number) => Promise<readonly EventPurgeJob[]>;
  /**
   * Validate that a stored R2 key belongs to (orgId, endpointId) — the readPayloadKey principal fence (H1).
   * A destructive path must NOT delete an object whose key doesn't match its own prefix. Returns false to
   * skip + alarm (the job is LEFT so the incident survives and re-alarms until a human resolves it).
   */
  validateKey: (orgId: string, endpointId: string, r2Key: string) => boolean;
  /** Delete one R2 payload object (idempotent — an absent key is a no-op). */
  deleteR2: (key: string) => Promise<void>;
  /** Mark a purge job completed (its durable proof the body is gone). */
  complete: (eventId: string) => Promise<void>;
  /** Max jobs to service per tick; the rest resumes next tick. */
  limit: number;
  /** Optional structured logger. Only non-PII fields (org id, counts) — never the raw key (its prefix
   *  could name another tenant). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface EventPayloadPurgeCronResult {
  /** Jobs whose R2 body was deleted and job completed this tick. */
  readonly purged: number;
  /** Jobs skipped because their stored key failed the principal fence (alarm signal; left for a human). */
  readonly fenced: number;
}

export async function runEventPayloadPurgeCron(
  deps: EventPayloadPurgeCronDeps,
): Promise<EventPayloadPurgeCronResult> {
  const jobs = await deps.claim(deps.limit);
  let purged = 0;
  let fenced = 0;

  for (const job of jobs) {
    if (!deps.validateKey(job.orgId, job.endpointId, job.r2Key)) {
      // A key that doesn't match its own org+endpoint prefix is corrupt or cross-tenant — never delete that
      // object, and LEAVE the job so the incident survives for investigation and re-alarms next tick. Log
      // counts + the (own) org id only, never the raw key.
      fenced += 1;
      deps.log?.("event_payload_purge.key_fence_skip", { orgId: job.orgId });
      continue;
    }
    // R2 delete (idempotent) BEFORE the completion write: a crash in between just re-deletes an already-gone
    // object next tick, never a job silently marked done with its body still present.
    await deps.deleteR2(job.r2Key);
    await deps.complete(job.eventId);
    purged += 1;
  }

  deps.log?.("event_payload_purge.done", { purged, fenced });
  return { purged, fenced };
}
