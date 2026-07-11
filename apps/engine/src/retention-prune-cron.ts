// The per-plan retention prune drain (data-lifecycle slice 2.3). Pure + dependency-injected so it
// unit-tests with fakes; the engine's scheduled() handler wires the real deps (a webhook_retention
// cross-org DB connection that enumerates aged events + deletes them, and the R2_PAYLOADS bucket).
//
// Each org's captured events are deleted once they age past THAT ORG'S OWN retention window — Free 7 days,
// Pro 30, Scale 90, or unlimited (never pruned). The window is never passed in from here: it lives on the
// org's row (`orgs.retention_days`, migration 0054) and is enforced by the DELETE policy itself. For every
// expiring event the payload BODY in R2 must go too — the R2 key is content-addressed (it folds in the body
// hash), so it is read from the stored row.
//
// Ordering is load-bearing: delete the ROWS first (an atomic DELETE that re-reads the org's window), then
// delete R2 for ONLY the ids the DELETE actually removed. This closes the TOCTOU on a window that GREW
// mid-tick — if an org upgrades between listing and deleting, the DELETE returns fewer/zero ids and those
// payload bodies are never touched. The cost is a benign, sweepable R2 orphan if we crash between the row
// delete and the R2 delete — strictly preferable to irreversibly destroying data the customer just paid to
// keep (deleting R2 first would do exactly that on an upgrade). Bounded per tick so a large backlog never
// blows the Workers subrequest/CPU ceiling — the remainder resumes next tick.

/** One event whose payload body must be purged from R2, then whose row is deleted. */
export interface ExpiringEvent {
  readonly id: string;
  /** The owning endpoint — fences the stored R2 key to `org/{orgId}/ep/{endpointId}/` before we delete it. */
  readonly endpointId: string;
  readonly r2Key: string;
}

export interface RetentionPruneCronDeps {
  /** The orgs holding events aged past THEIR OWN plan's retention window (read from the row, not passed in). */
  claimOrgs: (limit: number) => Promise<readonly string[]>;
  /** A page of an org's expiring events (id + endpoint + the R2 key to purge), oldest-first, up to `limit`. */
  listExpiring: (orgId: string, limit: number) => Promise<readonly ExpiringEvent[]>;
  /**
   * Validate that a stored R2 key belongs to (orgId, endpointId) — the readPayloadKey principal fence (H1).
   * A destructive path must NOT delete an object whose key doesn't match its own prefix (a corrupted or
   * cross-tenant key could otherwise destroy a victim's payload). Returns false to skip + alarm.
   */
  validateKey: (orgId: string, endpointId: string, r2Key: string) => boolean;
  /** Delete the given R2 payload objects (idempotent — an absent key is a no-op). */
  deleteR2: (keys: string[]) => Promise<void>;
  /**
   * Delete the given event rows for an org (cascades delivery_attempts) and return the ids ACTUALLY deleted.
   * The DELETE re-asserts the org's CURRENT window, re-read from its row — so an upgrade that lengthened the
   * window mid-tick returns FEWER (or zero) ids. The caller purges R2 only for those, and therefore can never
   * destroy a payload body whose row still exists.
   */
  deleteEvents: (orgId: string, ids: string[]) => Promise<readonly string[]>;
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
  /** Events skipped this tick because their stored R2 key failed the principal fence (alarm signal). */
  readonly fenced: number;
}

/** Drain expired events + their R2 payload bodies, one bounded slice at a time. */
export async function runRetentionPruneCron(
  deps: RetentionPruneCronDeps,
): Promise<RetentionPruneCronResult> {
  const orgs = await deps.claimOrgs(deps.orgLimit);
  let deleted = 0;
  let fenced = 0; // events skipped because their stored R2 key failed the principal fence

  for (const orgId of orgs) {
    for (let batch = 0; batch < deps.batchesPerOrg; batch++) {
      const page = await deps.listExpiring(orgId, deps.pageSize);
      if (page.length === 0) break; // org drained

      // Fence every stored key to this org+endpoint before touching R2. A key that doesn't match its own
      // prefix is corrupt or cross-tenant — we must NOT delete that object (it could be a victim's) and we
      // LEAVE the row too, so the incident survives for investigation and re-alarms until a human resolves
      // it. Log counts + the (own) org id only — never the raw key, whose prefix could name another tenant.
      const valid = page.filter((e) => deps.validateKey(orgId, e.endpointId, e.r2Key));
      const skipped = page.length - valid.length;
      if (skipped > 0) {
        fenced += skipped;
        deps.log?.("retention_prune.key_fence_skip", { orgId, count: skipped });
      }

      if (valid.length > 0) {
        // ROWS first, then R2 for ONLY the ids the DELETE actually removed. The DELETE re-reads the org's
        // window, so if the org upgraded between listing and now (a LONGER window), it returns fewer (or zero)
        // ids and those payload bodies are never touched. The tradeoff vs deleting R2 first is a benign,
        // sweepable R2 ORPHAN if we crash between the row delete and the R2 delete — strictly preferable to
        // irreversibly destroying data the customer just paid to keep.
        const deletedIds = new Set(
          await deps.deleteEvents(
            orgId,
            valid.map((e) => e.id),
          ),
        );
        const keys = valid.filter((e) => deletedIds.has(e.id)).map((e) => e.r2Key);
        if (keys.length > 0) await deps.deleteR2(keys);
        deleted += deletedIds.size;
      }

      // A fenced row stays in the table and would re-list forever, so once a page hits the fence we prune its
      // clean rows and PAUSE this org for the tick — it resumes next tick (and the incident re-alarms) rather
      // than re-scanning the same poison every batch.
      if (skipped > 0) break;
      if (page.length < deps.pageSize) break; // last (short) page — org drained
    }
  }

  deps.log?.("retention_prune.done", { orgs: orgs.length, deleted, fenced });
  return { orgs: orgs.length, deleted, fenced };
}
