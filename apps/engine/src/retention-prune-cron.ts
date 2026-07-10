// The per-plan retention prune drain (data-lifecycle slice 2.3). Pure + dependency-injected so it
// unit-tests with fakes; the engine's scheduled() handler wires the real deps (a webhook_retention
// cross-org DB connection that enumerates aged events + deletes them, and the R2_PAYLOADS bucket).
//
// Each org's captured events are deleted once they age past that org's retention window (Free = 7 days;
// paid orgs are EXCLUDED at the claim step until per-plan windows are wired at billing activation). For
// every expiring event the payload BODY in R2 must go too — and the R2 key is content-addressed (it folds
// in the body hash), so it can only be read from the stored row. Ordering is therefore load-bearing:
// delete the R2 object BEFORE the row. If we deleted the row first and then crashed, the key would be gone
// and the R2 object orphaned forever; deleting R2-then-row means a crash simply re-lists the same rows next
// tick and retries (R2 delete of an already-gone key is a no-op). Bounded per tick so a large backlog never
// blows the Workers subrequest/CPU ceiling — the remainder resumes next tick.

/** One event whose payload body must be purged from R2, then whose row is deleted. */
export interface ExpiringEvent {
  readonly id: string;
  readonly r2Key: string;
}

export interface RetentionPruneCronDeps {
  /** The orgs with events older than `retentionDays` that are eligible to prune (paid orgs excluded). */
  claimOrgs: (retentionDays: number, limit: number) => Promise<readonly string[]>;
  /** A page of an org's expiring events (id + the R2 key to purge), oldest-window-first, up to `limit`. */
  listExpiring: (
    orgId: string,
    retentionDays: number,
    limit: number,
  ) => Promise<readonly ExpiringEvent[]>;
  /** Delete the given R2 payload objects (idempotent — an absent key is a no-op). */
  deleteR2: (keys: string[]) => Promise<void>;
  /** Delete the given event rows for an org (cascades delivery_attempts); returns the row count. */
  deleteEvents: (orgId: string, ids: string[]) => Promise<number>;
  /** The retention window in days (Free = 7 while billing is dark). */
  retentionDays: number;
  /** Max orgs to service per tick. */
  orgLimit: number;
  /** Max list→purge→delete batches per org per tick; the rest resumes next tick. */
  batchesPerOrg: number;
  /** Rows per batch (also the R2 batch-delete size; keep <= 1000, R2's per-call ceiling). */
  pageSize: number;
  /** Optional structured logger. Only non-PII fields (org id, counts) are passed. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RetentionPruneCronResult {
  /** Orgs serviced this tick. */
  readonly orgs: number;
  /** Total events (and their R2 bodies) pruned this tick. */
  readonly deleted: number;
}

/** Drain expired events + their R2 payload bodies, one bounded slice at a time. */
export async function runRetentionPruneCron(
  deps: RetentionPruneCronDeps,
): Promise<RetentionPruneCronResult> {
  const orgs = await deps.claimOrgs(deps.retentionDays, deps.orgLimit);
  let deleted = 0;

  for (const orgId of orgs) {
    for (let batch = 0; batch < deps.batchesPerOrg; batch++) {
      const page = await deps.listExpiring(orgId, deps.retentionDays, deps.pageSize);
      if (page.length === 0) break; // org drained
      // R2 objects FIRST — the content-addressed key lives only on the row we are about to delete.
      await deps.deleteR2(page.map((e) => e.r2Key));
      deleted += await deps.deleteEvents(
        orgId,
        page.map((e) => e.id),
      );
      if (page.length < deps.pageSize) break; // last (short) page — org drained
    }
  }

  deps.log?.("retention_prune.done", { orgs: orgs.length, deleted });
  return { orgs: orgs.length, deleted };
}
