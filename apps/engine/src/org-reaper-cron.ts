// The async org-deletion reaper (#665, follow-up to #635). Pure + dependency-injected so it unit-tests with
// fakes; the engine's scheduled() handler wires the real deps (a webhook_reaper cross-org DB connection).
//
// After an owner REQUESTS an org delete (requestOrgDeletion), the org is marked `status='deleting'` and its
// tenant tree is left in place. This drain claims deleting orgs oldest-first and, per org, deletes its events
// in bounded chunks per tick (deleting an event cascades its delivery_attempts) until they are exhausted,
// then drops the org row. It is idempotent + resumable: a crash mid-tick leaves the org `deleting`, and the
// next tick re-claims it and continues from whatever rows remain — no cursor to persist (deleted rows are
// simply gone). Mirrors the R2 payload-purge drain (which clears the same org's payload BODIES from R2).

export interface OrgReaperCronDeps {
  /** Claim up to `n` orgs awaiting reaping (a webhook_reaper cross-org read), oldest request first. */
  claim: (n: number) => Promise<readonly string[]>;
  /** Delete up to `chunkSize` of an org's events (cascading their attempts); resolves to the rows deleted. */
  reapChunk: (orgId: string) => Promise<number>;
  /** Drop a drained org's row (the small remaining cascade). Resolves true if a row was deleted. */
  finalize: (orgId: string) => Promise<boolean>;
  /** Max orgs to work per tick. */
  jobLimit: number;
  /** Max chunk-deletes per org per tick — bounds Worker CPU/subrequests; the rest resumes next tick. */
  chunksPerJob: number;
  /** The chunk size `reapChunk` uses. A chunk that deletes fewer than this is the tail (org drained). */
  chunkSize: number;
  /** Optional structured logger. Only non-PII fields (org id, counts) are passed. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OrgReaperCronResult {
  /** Deleting orgs worked this tick. */
  readonly orgs: number;
  /** Total events deleted this tick (delivery_attempts cascade, uncounted). */
  readonly deleted: number;
  /** Orgs fully drained AND finalized (row dropped) this tick. */
  readonly finalized: number;
}

/** Drain outstanding org deletions, one bounded slice at a time. */
export async function runOrgReaperCron(deps: OrgReaperCronDeps): Promise<OrgReaperCronResult> {
  const orgs = await deps.claim(deps.jobLimit);
  let deleted = 0;
  let finalized = 0;

  for (const orgId of orgs) {
    let drained = false;
    for (let chunk = 0; chunk < deps.chunksPerJob; chunk++) {
      const n = await deps.reapChunk(orgId);
      deleted += n;
      // A short chunk means the org's events are exhausted — finalize it this tick.
      if (n < deps.chunkSize) {
        drained = true;
        break;
      }
    }
    // If we hit the per-tick chunk budget without draining, leave the org `deleting` for the next tick.
    if (drained && (await deps.finalize(orgId))) finalized++;
  }

  deps.log?.("org_reaper.done", { orgs: orgs.length, deleted, finalized });
  return { orgs: orgs.length, deleted, finalized };
}
