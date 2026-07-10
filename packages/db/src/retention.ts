import { BILLING_ACTIVE_STATUSES } from "@webhook-co/shared";

import type { Sql } from "./client";

// The retention-prune data-access layer (data-lifecycle slice 2.3). Runs as `webhook_retention` on its own
// connection (NOT withTenant) — the role-targeted `FOR SELECT/DELETE TO webhook_retention` policies (0053)
// are the sole bound, a bare cross-org read+delete of the columns the role can see. The pure, batched cron
// orchestration lives in apps/engine (runRetentionPruneCron); these are the thin real-SQL seams it wires.
//
// The prune EXCLUDES entitled (paid) orgs: while billing is dark billing_subscriptions is empty so every
// org is Free (7-day window), and the moment a paid subscription appears that org is auto-skipped (kept
// unbounded) until per-plan windows are wired at billing activation — over-retention is the safe miss.

/** One event whose captured body must be purged from R2 before the row is deleted. */
export interface ExpiringEvent {
  readonly id: string;
  /** The STORED content-addressed R2 object key (cannot be re-derived — must come from the row). */
  readonly r2Key: string;
}

/**
 * The org ids that have events older than `retentionDays` AND are NOT entitled to a paid plan — the orgs
 * the prune may act on this tick. Entitled = an active/trialing/past_due subscription (BILLING_ACTIVE_
 * STATUSES); such orgs are skipped so a paying customer is never pruned at the Free window. Oldest-events
 * first isn't meaningful here (we return ids, not rows); `distinct` + `limit` bound the fan-out. The
 * received_at range rides events_received_at_brin (0040); the anti-join hits billing_subscriptions' PK.
 */
export async function claimRetentionOrgs(
  retention: Sql,
  retentionDays: number,
  limit: number,
): Promise<string[]> {
  const rows = await retention<{ orgId: string }[]>`
    select distinct e.org_id as "orgId"
    from events e
    where e.received_at < now() - (${retentionDays} * interval '1 day')
      and not exists (
        select 1 from billing_subscriptions b
        where b.org_id = e.org_id
          and b.status in ${retention(BILLING_ACTIVE_STATUSES as unknown as string[])}
      )
    limit ${limit}`;
  return rows.map((r) => r.orgId);
}

/**
 * A page of an org's events older than `retentionDays`, with the R2 key to purge. Bounded by `limit`; the
 * caller pages until a short page signals the org is drained. Rides events_org_recent_idx (org_id,
 * received_at). Returns the content-addressed payload_r2_key so the cron can delete the R2 object BEFORE the
 * row (the key lives only on the row — delete the row first and the object is orphaned forever).
 */
export async function listExpiringEvents(
  retention: Sql,
  orgId: string,
  retentionDays: number,
  limit: number,
): Promise<ExpiringEvent[]> {
  return retention<ExpiringEvent[]>`
    select id, payload_r2_key as "r2Key"
    from events
    where org_id = ${orgId}
      and received_at < now() - (${retentionDays} * interval '1 day')
    limit ${limit}`;
}

/**
 * Delete a batch of an org's expired events by id (cascades their delivery_attempts via the ON DELETE
 * CASCADE FK). Scoped to `orgId` by the query; the role-targeted DELETE policy's `received_at < now() - 7d`
 * floor is the backstop that keeps a bug from ever removing an in-retention event. Returns the row count.
 */
export async function deleteExpiredEvents(
  retention: Sql,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await retention<{ id: string }[]>`
    delete from events
    where org_id = ${orgId} and id in ${retention(ids as string[])}
    returning id`;
  return rows.length;
}
