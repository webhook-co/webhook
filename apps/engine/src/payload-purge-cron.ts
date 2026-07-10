// The durable R2 payload-body purge drain (data-lifecycle slice 2.1). Pure + dependency-injected so
// it unit-tests with fakes; the engine's scheduled() handler wires the real deps (a webhook_purge
// cross-org DB connection that claims/advances org_deletions jobs, and the R2_PAYLOADS bucket).
//
// After an owner hard-deletes an org, its captured payload BODIES still live in R2 (outside
// Postgres), so a job is enqueued in org_deletions. This drain clears the `org/{orgId}/` prefix in
// bounded batches per tick until it is empty, then marks the job completed. It is idempotent:
// deleting an already-deleted key is a no-op, and R2's cursor points PAST the keys just listed, so a
// crash mid-tick simply re-lists from the saved cursor (or the start) and continues without skipping.

/** One outstanding purge job: the deleted org + where its last pass left off (null = restart). */
export interface PurgeJob {
  readonly orgId: string;
  readonly cursor: string | null;
}

/** The minimal R2 surface the drain needs — structurally satisfied by a Cloudflare `R2Bucket`. */
export interface PurgeBucket {
  list(opts: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

export interface PayloadPurgeCronDeps {
  /** Claim up to `n` outstanding jobs (a webhook_purge cross-org read), oldest first. */
  claim: (n: number) => Promise<readonly PurgeJob[]>;
  /** The payload bucket to enumerate + delete from. */
  bucket: PurgeBucket;
  /** Persist a batch's progress: accumulate `deltaObjects`, save `cursor`, or finish when `done`. */
  advance: (input: {
    orgId: string;
    cursor: string | null;
    deltaObjects: number;
    done: boolean;
  }) => Promise<void>;
  /** Max jobs to drain per tick. */
  jobLimit: number;
  /** Max R2 list+delete batches per job per tick — bounds Worker CPU/subrequests; the rest resumes next tick. */
  batchesPerJob: number;
  /** R2 list page size (<= 1000, R2's per-call batch-delete ceiling). */
  pageSize: number;
  /** Optional structured logger. Only non-PII fields (org id, counts) are passed. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PayloadPurgeCronResult {
  /** Jobs touched this tick. */
  readonly jobs: number;
  /** Total R2 objects deleted this tick. */
  readonly deleted: number;
  /** Jobs that reached the end of their prefix and were marked completed this tick. */
  readonly completed: number;
}

/** Drain outstanding org-deletion payload purges, one bounded slice at a time. */
export async function runPayloadPurgeCron(
  deps: PayloadPurgeCronDeps,
): Promise<PayloadPurgeCronResult> {
  const jobs = await deps.claim(deps.jobLimit);
  let deleted = 0;
  let completed = 0;

  for (const job of jobs) {
    let cursor = job.cursor;
    for (let batch = 0; batch < deps.batchesPerJob; batch++) {
      const listed = await deps.bucket.list({
        prefix: `org/${job.orgId}/`,
        cursor: cursor ?? undefined,
        limit: deps.pageSize,
      });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length > 0) await deps.bucket.delete(keys);
      const done = !listed.truncated;
      // Persist progress after EVERY batch so a crash mid-job loses at most one page of re-work.
      await deps.advance({
        orgId: job.orgId,
        cursor: done ? null : (listed.cursor ?? null),
        deltaObjects: keys.length,
        done,
      });
      deleted += keys.length;
      if (done) {
        completed++;
        break;
      }
      cursor = listed.cursor ?? null;
    }
  }

  deps.log?.("payload_purge.done", { jobs: jobs.length, deleted, completed });
  return { jobs: jobs.length, deleted, completed };
}
