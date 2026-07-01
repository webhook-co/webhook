// Delivery reconciliation (S3 Slice 3 PR3c-2). The native auto-delivery loop wakes a destination's
// per-destination DO inline at ingest, and the DO drains ALL due deliveries on any wake — so an active DO
// self-heals. The gap is a destination whose DO went IDLE while a due delivery sits unclaimed:
//   1. a LOST wake — the delivery row committed but the post-ACK DO fan-out failed; or
//   2. a RE-ENABLED destination — `replay enable` clears the disable flag but doesn't wake the (idle) DO to
//      drain the queued rows that accrued while it was disabled.
// The engine's hourly cron closes both by re-waking any destination that HAS due work, cross-org. This
// module is the READ half: find those destinations. The wake itself (idempotent) lives in the engine.

import type { Sql } from "./client";

/** A destination that owns at least one due, unclaimed delivery — the engine wakes its DO. */
export interface DueDestination {
  readonly orgId: string;
  readonly destinationId: string;
}

/**
 * A delivery must have been due for at least this grace before the reconciler surfaces it. A freshly-queued
 * row is already being drained by the DO the ingest path woke inline; re-waking it here would be redundant.
 * So the reconciler only looks at work that's been due a while — genuinely stranded (a lost wake, a re-enabled
 * destination) — which keeps the steady-state candidate set near-empty and reserves the cron's bounded fan-out
 * for destinations that actually need it. The recovery latency for a truly-lost wake is (grace + one cron
 * interval), which the hourly interval dominates anyway.
 */
const DUE_GRACE_SECONDS = 120;

/** Default per-pass cap. Well under the Workers per-invocation subrequest ceiling (the cron wakes one DO per
 *  returned row), so a single scheduled() invocation can safely wake the whole batch. */
export const DEFAULT_RECONCILE_LIMIT = 500;

/**
 * A cross-org read of the (org, destination) pairs that have a due delivery on a live, enabled destination —
 * i.e. exactly the DOs the reconciler should re-wake. Run on a **webhook_reconciler** connection (the caller
 * passes a reconciler-scoped postgres.js client): that role's role-targeted `FOR SELECT TO webhook_reconciler
 * USING (true)` policies on delivery_attempts + replay_destinations grant the cross-org read WITHOUT a
 * BYPASSRLS/SECURITY-DEFINER bypass, and its column grants bound the read to the reconciliation keys only.
 * There is NO withTenant and NO tenant GUC — the scan spans all orgs, which is what stranded work across
 * abandoned/idle DOs needs.
 *
 * A delivery is "due" when it is still open (`queued` | `pending`) AND it has been due for at least
 * DUE_GRACE_SECONDS (null next_retry_at = immediately eligible). A `pending` row scheduled for a FUTURE retry
 * is deliberately excluded — its DO already holds an alarm for that slot, so re-waking now would just no-op
 * the drain. The destination must be live (not soft-deleted) and enabled (not auto-disabled): a disabled
 * destination must NOT deliver, so its owed rows wait (a future `replay enable` clears the flag and the next
 * reconciler pass picks them up). `group by` collapses a destination with many due deliveries to a single wake.
 *
 * `limit` bounds a single pass so one run can't fan out past the Workers subrequest ceiling. Ordering is
 * RANDOM, not a fixed sort: under a large backlog (> limit) a deterministic `order by ... limit` would keep
 * re-selecting the same lexicographic prefix and permanently STARVE the rest; random ordering gives every
 * stranded destination a fair chance across successive passes so none is stuck indefinitely. The caller logs
 * when the cap is hit so a capped pass is observable rather than a silent truncation.
 */
export async function listDestinationsWithDueDeliveries(
  sql: Sql,
  limit = DEFAULT_RECONCILE_LIMIT,
): Promise<DueDestination[]> {
  const rows = await sql<{ org_id: string; destination_id: string }[]>`
    select da.org_id, da.destination_id
    from delivery_attempts da
    join replay_destinations d
      on d.id = da.destination_id and d.org_id = da.org_id
    where da.status in ('queued', 'pending')
      and (da.next_retry_at is null or da.next_retry_at < now() - make_interval(secs => ${DUE_GRACE_SECONDS}))
      and d.deleted_at is null
      and d.disabled_at is null
    group by da.org_id, da.destination_id
    order by random()
    limit ${limit}`;
  return rows.map((r) => ({ orgId: r.org_id, destinationId: r.destination_id }));
}
