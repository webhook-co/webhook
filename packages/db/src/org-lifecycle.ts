import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";

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
