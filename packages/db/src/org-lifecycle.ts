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
  input: { orgId: string; actor: string | null },
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
    await tx`
      insert into org_deletions (org_id, requested_by)
      values (${input.orgId}, ${input.actor})`;
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
