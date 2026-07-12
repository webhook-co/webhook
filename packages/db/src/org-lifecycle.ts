import { formatAuditActor, type AuditActorInput } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";

// Re-exported through this leaf so the web dashboard (which imports leaf subpaths, not the barrel —
// Turbopack) can resolve the deterministic personal-org id for account erasure alongside
// deleteOrgWithAudit / isOrgOwner.
export { personalOrgId } from "./orgs";

/**
 * Thrown when an org delete targets a row that doesn't exist in the caller's RLS context — i.e.
 * the org is already gone. Callers translate this to a 404; the transaction has rolled back, so
 * no audit row or purge job is left behind.
 */
export class OrgNotFoundError extends Error {
  constructor(readonly orgId: string) {
    super(`org ${orgId} not found for deletion`);
    this.name = "OrgNotFoundError";
  }
}

/**
 * Is `userId` an OWNER of `orgId`? Membership is access control: RLS only proves a lookup is scoped
 * to the context org, never that the caller may perform owner-only actions — so destructive
 * org-level operations (org delete, erasure) MUST gate on this. Mirrors `isOrgMember` (orgs.ts),
 * narrowed to the `owner` role.
 */
export async function isOrgOwner(app: Sql, userId: string, orgId: string): Promise<boolean> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ one: number }[]>`
        select 1 as one from memberships
        where org_id = ${orgId} and user_id = ${userId} and role = 'owner' limit 1`,
  );
  return rows.length > 0;
}

/** How many members an org has, and how many of them are owners — the input to the last-owner guard. */
export interface OrgMembershipCensus {
  readonly owners: number;
  readonly total: number;
}

/**
 * Count the org's members and how many hold the `owner` role. Runs under the org's RLS context like
 * isOrgOwner, with an EXPLICIT `org_id` predicate — RLS policies are permissive/OR'd, so a future policy
 * could widen the visible set; never lean on RLS alone for a count (see readMembershipRole's warning).
 */
export async function readOrgMembershipCensus(
  app: Sql,
  orgId: string,
): Promise<OrgMembershipCensus> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ owners: string; total: string }[]>`
        select
          count(*) filter (where role = 'owner') as owners,
          count(*) as total
        from memberships
        where org_id = ${orgId}`,
  );
  return { owners: Number(row?.owners ?? 0), total: Number(row?.total ?? 0) };
}

/**
 * Would removing this org's SOLE owner orphan it — leave members with no owner? True iff there is exactly
 * one owner and at least one other member. A zero-owner org is a trap: it can never be deleted again
 * (isOrgOwner is false for everyone, so deleteOrgWithAudit can't be called), its failure alerts go nowhere
 * (notifier's owner LEFT JOIN finds none), and its Stripe subscription runs on with no one able to manage
 * it. So a sole owner must transfer ownership before they can leave. A SOLO org (the owner is the only
 * member) is safe — nothing is orphaned. This is the guard's whole decision, kept pure for testing.
 */
export function lastOwnerWouldOrphan(census: OrgMembershipCensus): boolean {
  return census.owners === 1 && census.total > 1;
}

/**
 * Hard-delete an org and all of its Postgres metadata (every `org_id` child table is
 * `ON DELETE CASCADE`), while PRESERVING the two append-only WORM audit trails — `audit_log` and
 * `auth_audit_event` had their `orgs` FK decoupled in migration 0051, so the cascade no longer
 * fires their row-level `no_delete` triggers (which would abort the whole delete) and their
 * tamper-evident, R2-anchored, pseudonymous history survives. Captured payload BODIES live in R2,
 * outside Postgres, so they are not cascaded here: a durable purge job is enqueued in
 * `org_deletions` and drained by the engine's `webhook_purge` cron.
 *
 * Runs as `webhook_app` under RLS pinned to `orgId`. AUTHZ is the caller's responsibility: verify
 * the principal is an owner (`isOrgOwner`) BEFORE calling — RLS proves the caller is *in* the org,
 * never that they may delete it.
 */
export async function deleteOrgWithAudit(
  app: Sql,
  input: { orgId: string; actor: AuditActorInput },
  auditKey: CryptoKey,
): Promise<{ orgId: string; deletedAt: string }> {
  return withTenant(app, input.orgId, async (tx) => {
    // Close out the tamper-evident chain first. audit_log has no FK to orgs (0051), so this row
    // survives the delete below — and if the delete finds nothing, the throw rolls the whole
    // transaction back, leaving no orphan audit row or purge job.
    await appendAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.actor,
      action: "org.deleted",
      target: input.orgId,
    });
    // Enqueue the durable R2 payload-body purge (also FK-free, so it outlives the org row). The
    // insert `with check (org_id = current_org_id())` is why a tenant can't forge another org's job.
    // `requested_by` keeps the encoding it ALREADY has. This column (0051) holds bare user ids for every org
    // deleted before today, and there is no migration to rewrite them — so writing the prefixed `user:<id>`
    // form here would leave one column carrying two incompatible encodings, and a lookup of "who requested
    // this deletion" would silently find nothing for exactly the rows we meant to attribute. A user actor
    // therefore still writes its bare id (org deletion is only ever a web session action today). A non-user
    // actor writes the prefixed form, which cannot collide with a bare id and cannot pre-exist. The purge
    // role deliberately cannot read this column at all (0051).
    const requestedBy =
      input.actor.kind === "user" ? input.actor.id : formatAuditActor(input.actor);
    await tx`
      insert into org_deletions (org_id, requested_by)
      values (${input.orgId}, ${requestedBy})`;
    // Hard-delete: every org_id child cascades; the two WORM audit tables + org_deletions persist.
    const [row] = await tx<{ deletedAt: string }[]>`
      delete from orgs where id = ${input.orgId} returning now()::text as "deletedAt"`;
    if (!row) {
      throw new OrgNotFoundError(input.orgId);
    }
    return { orgId: input.orgId, deletedAt: row.deletedAt };
  });
}

/** One outstanding R2-purge job: the deleted org and where its last purge pass left off. */
export interface PurgeJob {
  orgId: string;
  /** The R2 list cursor to resume from, or null to (re)start at the beginning of the prefix. */
  cursor: string | null;
}

/**
 * Read outstanding R2-purge jobs (oldest first) for the engine drain. Runs as `webhook_purge` on
 * its own connection (NOT `withTenant`) — the role-targeted `FOR SELECT TO webhook_purge` policy is
 * the sole bound, so this is a bare cross-org read of a table the role can only see, never mutate
 * beyond its column-scoped UPDATE. The `partial index on (requested_at) where status='purging'`
 * keeps the scan index-driven.
 */
export async function claimPurgeJobs(purge: Sql, limit: number): Promise<PurgeJob[]> {
  return purge<PurgeJob[]>`
    select org_id as "orgId", r2_cursor as cursor
    from org_deletions
    where status = 'purging'
    order by requested_at
    limit ${limit}`;
}

/**
 * Advance a purge job after a batch of R2 objects was deleted. When `done`, the prefix is exhausted:
 * flip the job to `completed` and stamp `purge_completed_at` (its durable proof the payloads are
 * gone). Otherwise persist the resume `cursor` and accumulate the count so the next drain tick (or a
 * crash-retry) picks up exactly where this left off. Runs as `webhook_purge`; the `status='purging'`
 * predicate + the role-targeted UPDATE policy mean a completed job is never touched again.
 */
export async function advancePurgeJob(
  purge: Sql,
  input: { orgId: string; cursor: string | null; deltaObjects: number; done: boolean },
): Promise<void> {
  if (input.done) {
    await purge`
      update org_deletions
      set objects_purged = objects_purged + ${input.deltaObjects},
          r2_cursor = null,
          status = 'completed',
          purge_completed_at = now()
      where org_id = ${input.orgId} and status = 'purging'`;
    return;
  }
  await purge`
    update org_deletions
    set objects_purged = objects_purged + ${input.deltaObjects},
        r2_cursor = ${input.cursor}
    where org_id = ${input.orgId} and status = 'purging'`;
}
