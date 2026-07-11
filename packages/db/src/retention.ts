import type { Sql } from "./client";

// The retention-prune data-access layer (data-lifecycle slice 2.3). Runs as `webhook_retention` on its own
// connection (NOT withTenant) — the role-targeted `FOR SELECT/DELETE TO webhook_retention` policies are the
// sole bound, a bare cross-org read+delete of the columns the role can see. The pure, batched cron
// orchestration lives in apps/engine (runRetentionPruneCron); these are the thin real-SQL seams it wires.
//
// The window is PER-ORG (`orgs.retention_days`, mirrored from the plan's Stripe price metadata by
// billing-sync — 0054). It is never passed in by the caller: an app-supplied window would be one more place
// that could disagree with the plan the customer actually bought, and the whole point of putting it in the
// row is that the DELETE policy can enforce it without trusting us.
//
// `retention_days IS NULL` = UNLIMITED. That needs no special case anywhere: `NULL * interval` is NULL, so
// `received_at < now() - NULL` is NULL — never true — and the row is simply never selected or deleted.
//
// The window predicate is re-asserted at the claim, the list, AND the delete (not just the claim), so a plan
// change landing mid-tick can never let a shorter window delete data the org's CURRENT plan still covers.
// A claim-only check would be TOCTOU on the one thing this design treats as catastrophic.

/** One expiring event: its row is deleted, then (if the delete succeeded) its R2 payload body is purged. */
export interface ExpiringEvent {
  readonly id: string;
  /** The owning endpoint — used to fence the stored R2 key to `org/{orgId}/ep/{endpointId}/` before delete. */
  readonly endpointId: string;
  /** The STORED content-addressed R2 object key (cannot be re-derived — must come from the row). */
  readonly r2Key: string;
}

/**
 * The org ids holding events that have aged past THAT ORG'S OWN retention window — the orgs the prune may act
 * on this tick, OLDEST-DATA-FIRST so a backlog larger than `limit` drains fairly (no org starves, and the
 * most-overdue data goes first). An org on an unlimited window (`retention_days IS NULL`) never appears.
 * The received_at range rides events_received_at_brin (0040); the join hits orgs' PK.
 */
export async function claimRetentionOrgs(retention: Sql, limit: number): Promise<string[]> {
  const rows = await retention<{ orgId: string }[]>`
    select e.org_id as "orgId"
    from events e
    join orgs o on o.id = e.org_id
    where e.received_at < now() - (o.retention_days * interval '1 day')
    group by e.org_id
    order by min(e.received_at)
    limit ${limit}`;
  return rows.map((r) => r.orgId);
}

/**
 * A page of one org's events aged past its own window, with the owning endpoint + the R2 key to purge.
 * Bounded by `limit`; the caller pages until a short page signals the org is drained. Returns the
 * content-addressed payload_r2_key (the caller purges each object AFTER its row is deleted, keyed by the
 * delete's returned ids) and `endpoint_id` so the cron can fence the key to the principal's prefix first.
 */
export async function listExpiringEvents(
  retention: Sql,
  orgId: string,
  limit: number,
): Promise<ExpiringEvent[]> {
  return retention<ExpiringEvent[]>`
    select e.id, e.endpoint_id as "endpointId", e.payload_r2_key as "r2Key"
    from events e
    join orgs o on o.id = e.org_id
    where e.org_id = ${orgId}
      and e.received_at < now() - (o.retention_days * interval '1 day')
    limit ${limit}`;
}

/**
 * Delete a batch of an org's expired events by id (cascading their delivery_attempts via the ON DELETE
 * CASCADE FK) and return the ids ACTUALLY deleted. The DELETE re-asserts every safety predicate, so it is
 * atomically correct regardless of what changed since the ids were read: scoped to `orgId`, and past that
 * org's CURRENT window — re-read here, so an upgrade that lengthened the window mid-tick spares the data
 * rather than deleting it on a stale read. The role-targeted DELETE policy (0054) enforces the same window
 * independently. The caller purges R2 only for the RETURNED ids, so a window that grew mid-tick (fewer/zero
 * ids returned) can never orphan payload bodies whose rows still exist.
 */
export async function deleteExpiredEvents(
  retention: Sql,
  orgId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await retention<{ id: string }[]>`
    delete from events e
    using orgs o
    where o.id = e.org_id
      and e.org_id = ${orgId}
      and e.id in ${retention(ids as string[])}
      and e.received_at < now() - (o.retention_days * interval '1 day')
    returning e.id`;
  return rows.map((r) => r.id);
}
