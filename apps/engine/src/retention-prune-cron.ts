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
  /**
   * Max orgs to drain CONCURRENTLY (a bounded pool over the outer org loop). Defaults to 1 (sequential) when
   * omitted. With batchesPerOrg raised for scale (S5), a full tick can be many thousands of round-trips; a
   * small pool keeps the drain comfortably inside the 15-minute cron wall time without exceeding the Worker's
   * simultaneous-connection headroom. Each org is isolated (see `failed`), so a pool never lets one org's
   * fault abort a sibling.
   */
  orgConcurrency?: number;
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
  /** Orgs whose drain THREW a dep fault (DB/R2). Isolated + counted, not fatal — the org's rows survive for
   *  the next tick (idempotent retry). A persistently non-zero `failed` is the operability alarm. */
  readonly failed: number;
}

/**
 * A TOTAL outage: every claimed org's drain faulted (nothing was accomplished). Per-org isolation means the
 * cron never rejects on a PARTIAL failure — right, since the healthy orgs' deletions are valid — but a total
 * outage (a bad role grant, schema drift, Hyperdrive down) would otherwise be invisible, sitting only as
 * `failed: N` in the success-path done-line. Retention is a COMPLIANCE-critical path, so the caller escalates
 * this (throws) to fire the standard "cron failed" alert. Zero claimed orgs is NOT a failure (nothing to do).
 */
export function isTotalRetentionFailure(result: RetentionPruneCronResult): boolean {
  return result.orgs > 0 && result.failed === result.orgs;
}

/** Per-org tallies from one drain. `failed` marks a dep fault that stopped this org early (isolated). */
interface OrgDrain {
  readonly deleted: number;
  readonly fenced: number;
  readonly failed: boolean;
}

/** A bounded, non-PII error descriptor for a log — the message only, never `String(err)` (which for a DB
 *  error can splice in the whole failing statement, e.g. the `in (...)` id list, or a connection DSN). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : "non-error thrown";
}

/**
 * Drain ONE org's expiring events, up to `batchesPerOrg` bounded batches. Rows-before-R2 ordering and the
 * key fence are per batch (see the top-of-file contract). SELF-ISOLATES a dep fault: it returns the tallies
 * ACCUMULATED SO FAR this tick (earlier batches' deletions are real + committed, so they must still be
 * counted) with `failed: true`, rather than throwing — so one org's DB/R2 blip neither aborts its siblings
 * (the caller runs orgs concurrently) nor loses this org's partial-progress count. The failed org's
 * remaining rows are simply left for the next tick (idempotent retry).
 */
async function drainOrg(orgId: string, deps: RetentionPruneCronDeps): Promise<OrgDrain> {
  let deleted = 0;
  let fenced = 0;
  try {
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
  } catch (err: unknown) {
    deps.log?.("retention_prune.org_failed", { orgId, error: errText(err) });
    return { deleted, fenced, failed: true }; // partial tallies preserved; org retried next tick
  }
  return { deleted, fenced, failed: false };
}

/** Drain expired events + their R2 payload bodies, one bounded slice at a time, across a bounded pool of orgs. */
export async function runRetentionPruneCron(
  deps: RetentionPruneCronDeps,
): Promise<RetentionPruneCronResult> {
  const orgs = await deps.claimOrgs(deps.orgLimit);
  let deleted = 0;
  let fenced = 0; // events skipped because their stored R2 key failed the principal fence
  let failed = 0; // orgs whose drain threw — isolated, counted, left for the next tick

  // Bounded pool over the orgs: at most `concurrency` drains in flight at once. A shared cursor hands each
  // worker the next org (single-threaded ⇒ the `cursor < len` check and `orgs[cursor++]` read run with no
  // await between them, so no org is handed to two workers or skipped). `drainOrg` self-isolates a fault
  // (returns `failed: true` with its partial tallies) so a worker never rejects and one org's DB/R2 blip
  // neither aborts its siblings nor loses this org's already-committed deletions from the count.
  const concurrency = Math.max(1, deps.orgConcurrency ?? 1);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < orgs.length) {
      const orgId = orgs[cursor++]!;
      const r = await drainOrg(orgId, deps);
      deleted += r.deleted;
      fenced += r.fenced;
      if (r.failed) failed += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, orgs.length) }, () => worker()));

  deps.log?.("retention_prune.done", { orgs: orgs.length, deleted, fenced, failed });
  return { orgs: orgs.length, deleted, fenced, failed };
}
