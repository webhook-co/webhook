import { BILLING_ACTIVE_STATUSES } from "@webhook-co/shared";

import type { Sql } from "./client";

// The retention-prune data-access layer (data-lifecycle slice 2.3). Runs as `webhook_retention` on its own
// connection (NOT withTenant) — the role-targeted `FOR SELECT/DELETE TO webhook_retention` policies (0053)
// are the sole bound, a bare cross-org read+delete of the columns the role can see. The pure, batched cron
// orchestration lives in apps/engine (runRetentionPruneCron); these are the thin real-SQL seams it wires.
//
// The prune EXCLUDES entitled (paid) orgs: while billing is dark billing_subscriptions is empty so every
// org is Free (7-day window), and the moment a paid subscription appears that org is auto-skipped (kept
// unbounded) until per-plan windows are wired at billing activation — over-retention is the safe miss. The
// entitlement anti-join is re-applied at BOTH the list AND the delete (not just the claim), so a
// subscription that appears mid-tick can never let a paid org's data be pruned at the Free window (a
// claim-only check would be TOCTOU on the one thing the design treats as catastrophic).

/** The `active/trialing/past_due` set that entitles an org to a paid plan — inlined into the anti-joins. */
const ENTITLED_STATUSES = BILLING_ACTIVE_STATUSES as unknown as string[];

/** One expiring event: its row is deleted, then (if the delete succeeded) its R2 payload body is purged. */
export interface ExpiringEvent {
  readonly id: string;
  /** The owning endpoint — used to fence the stored R2 key to `org/{orgId}/ep/{endpointId}/` before delete. */
  readonly endpointId: string;
  /** The STORED content-addressed R2 object key (cannot be re-derived — must come from the row). */
  readonly r2Key: string;
}

/**
 * The org ids that have events older than `retentionDays` AND are NOT entitled to a paid plan — the orgs
 * the prune may act on this tick, OLDEST-DATA-FIRST so a backlog larger than `limit` drains fairly (no org
 * starves and the most-overdue data goes first). Entitled = an active/trialing/past_due subscription; such
 * orgs are skipped so a paying customer is never pruned at the Free window. The received_at range rides
 * events_received_at_brin (0040); the anti-join hits billing_subscriptions' PK.
 */
export async function claimRetentionOrgs(
  retention: Sql,
  retentionDays: number,
  limit: number,
): Promise<string[]> {
  const rows = await retention<{ orgId: string }[]>`
    select e.org_id as "orgId"
    from events e
    where e.received_at < now() - (${retentionDays} * interval '1 day')
      and not exists (
        select 1 from billing_subscriptions b
        where b.org_id = e.org_id and b.status in ${retention(ENTITLED_STATUSES)}
      )
    group by e.org_id
    order by min(e.received_at)
    limit ${limit}`;
  return rows.map((r) => r.orgId);
}

/**
 * A page of an org's events older than `retentionDays`, with the owning endpoint + the R2 key to purge.
 * Re-applies the entitled-org anti-join (defence against a subscription appearing after the claim). Bounded
 * by `limit`; the caller pages until a short page signals the org is drained. Returns the content-addressed
 * payload_r2_key (the caller purges each object AFTER its row is deleted, keyed by the delete's returned ids)
 * and `endpoint_id` so the cron can fence the key to the principal's prefix before deleting it.
 */
export async function listExpiringEvents(
  retention: Sql,
  orgId: string,
  retentionDays: number,
  limit: number,
): Promise<ExpiringEvent[]> {
  return retention<ExpiringEvent[]>`
    select id, endpoint_id as "endpointId", payload_r2_key as "r2Key"
    from events e
    where e.org_id = ${orgId}
      and e.received_at < now() - (${retentionDays} * interval '1 day')
      and not exists (
        select 1 from billing_subscriptions b
        where b.org_id = e.org_id and b.status in ${retention(ENTITLED_STATUSES)}
      )
    limit ${limit}`;
}

/**
 * Delete a batch of an org's expired events by id (cascades their delivery_attempts via the ON DELETE
 * CASCADE FK) and return the ids ACTUALLY deleted. The DELETE re-asserts every safety predicate so it is
 * atomically correct regardless of what changed since the id list was read: scoped to `orgId`, `received_at`
 * past the window, and the entitled-org anti-join (a paid org's data is never pruned even if the subscription
 * appeared mid-tick). The role-targeted DELETE policy's `received_at < now() - 7d` floor is a further
 * backstop. The caller purges R2 only for the RETURNED ids — so a mid-tick entitlement flip (which makes the
 * anti-join return fewer/zero ids) can never orphan a still-paying org's payload bodies.
 */
export async function deleteExpiredEvents(
  retention: Sql,
  orgId: string,
  retentionDays: number,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await retention<{ id: string }[]>`
    delete from events e
    where e.org_id = ${orgId}
      and e.id in ${retention(ids as string[])}
      and e.received_at < now() - (${retentionDays} * interval '1 day')
      and not exists (
        select 1 from billing_subscriptions b
        where b.org_id = e.org_id and b.status in ${retention(ENTITLED_STATUSES)}
      )
    returning e.id`;
  return rows.map((r) => r.id);
}
