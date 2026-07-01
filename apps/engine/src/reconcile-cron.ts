// The delivery-reconciliation cron logic (S3 Slice 3 PR3c-2). Pure + dependency-injected so it unit-tests
// with fakes; the engine's scheduled() handler wires the real deps (a webhook_reconciler cross-org DB
// connection reading due destinations, and a DO waker). The native auto-delivery loop wakes a destination's
// DO inline at ingest, and the DO drains ALL due deliveries on any wake — so an ACTIVE DO self-heals. This
// cron closes the gap for an IDLE DO with stranded work: a lost wake (the delivery committed but the post-ACK
// fan-out failed) or a re-enabled destination (whose queued rows accrued while disabled). Re-waking is
// idempotent — a redundant wake against an already-draining DO is a no-op — so the cron can safely re-wake
// anything with due work. The recovery window equals the cron interval.

/** A destination with due, unclaimed delivery work — the cron wakes its DO. Kept local so this pure module
 *  doesn't import the Node-typed db package. */
export interface DueDestination {
  readonly orgId: string;
  readonly destinationId: string;
}

export interface ReconcileCronDeps {
  /** Read the (org, destination) pairs with due work across all orgs (a webhook_reconciler cross-org read). */
  listDue: () => Promise<readonly DueDestination[]>;
  /** Wake one destination's DO to drain (idempotent). */
  wake: (orgId: string, destinationId: string) => Promise<void>;
  /** The max destinations one pass reads; a pass at the cap is logged so truncation is never silent. */
  limit: number;
  /** Optional structured logger. Only non-PII fields (org id, destination id, counts) are passed. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ReconcileCronResult {
  /** Destinations whose DO was successfully woken. */
  readonly woken: number;
  /** Wakes that threw (logged + counted, non-fatal to the rest of the pass). */
  readonly failed: number;
  /** True when this pass read exactly `limit` destinations — more may remain for the next pass. */
  readonly capped: boolean;
}

/** Re-wake every destination that has due delivery work. */
/** Max wakes in flight at once. Each wake() is a subrequest; a bounded window keeps a large pass well under
 *  the Workers per-invocation subrequest ceiling and avoids thundering-herding the DO layer. */
const WAKE_CONCURRENCY = 25;

export async function runReconcileCron(deps: ReconcileCronDeps): Promise<ReconcileCronResult> {
  const due = await deps.listDue();
  let woken = 0;
  let failed = 0;

  // Wake in bounded batches rather than one unbounded Promise.all: `due` can be up to `limit` entries, and
  // firing that many DO RPCs at once would risk the subrequest cap. Sequential batches keep at most
  // WAKE_CONCURRENCY in flight; total subrequests stay = due.length <= limit.
  for (let i = 0; i < due.length; i += WAKE_CONCURRENCY) {
    const batch = due.slice(i, i + WAKE_CONCURRENCY);
    await Promise.all(
      batch.map(async (d) => {
        try {
          await deps.wake(d.orgId, d.destinationId);
          woken++;
        } catch (err) {
          // One destination's wake blip must not block the others; surface it and continue.
          failed++;
          deps.log?.("reconcile.wake_failed", {
            destinationId: d.destinationId,
            error: String(err),
          });
        }
      }),
    );
  }

  const capped = due.length >= deps.limit;
  if (capped) deps.log?.("reconcile.capped", { count: due.length, limit: deps.limit });
  deps.log?.("reconcile.done", { woken, failed });
  return { woken, failed, capped };
}
