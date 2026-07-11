import { randomUUID } from "node:crypto";

import { formatAuditActor, importAuditKey, userActor, verifyAuditChain } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry, readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  advancePurgeJob,
  claimPurgeJobs,
  deleteOrgWithAudit,
  isOrgOwner,
  OrgNotFoundError,
} from "../src/org-lifecycle";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Drives the org-delete lifecycle against a real Postgres so the WORM-audit decoupling (an org
// delete must NOT abort on the append-only triggers), the cascade, and the durable purge-job
// enqueue are all exercised end to end. All RLS assertions go through withTenant(app, orgId) —
// which still works after the org row is gone, because RLS keys on the app.current_org GUC, not
// the orgs row. The global identity `user` table (ungranted to webhook_app) is seeded on `owner`.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let purge: Sql;
let key: CryptoKey;

async function seedUser(id: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@example.test`}, ${true}, now())`;
}

/** Seed an org with an owner membership and a two-entry audit chain (org.created, endpoint.created). */
async function seedOrg(slug: string, ownerUserId: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
    await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${ownerUserId}, ${"owner"})`;
    await appendAuditEntry(tx, key, {
      orgId,
      actor: userActor(ownerUserId),
      action: "org.created",
      target: null,
    });
    await appendAuditEntry(tx, key, {
      orgId,
      actor: userActor(ownerUserId),
      action: "endpoint.created",
      target: "ep_1",
    });
  });
  return orgId;
}

const countIn = (orgId: string, table: string) =>
  withTenant(
    app,
    orgId,
    async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)}`)[0].n,
  );

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  purge = createClient(pg.urlFor({ role: DB_ROLES.purge }));
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await purge?.end();
  await pg?.stop();
});

describe("deleteOrgWithAudit", () => {
  it("hard-deletes the org + cascades children, preserves the audit chain, enqueues the purge job", async () => {
    const ownerId = `user_owner_${randomUUID().slice(0, 8)}`;
    await seedUser(ownerId);
    const orgA = await seedOrg("del-a", ownerId);

    const otherId = `user_other_${randomUUID().slice(0, 8)}`;
    await seedUser(otherId);
    const orgB = await seedOrg("del-b", otherId); // control — must be untouched

    const result = await deleteOrgWithAudit(app, { orgId: orgA, actor: userActor(ownerId) }, key);
    expect(result.orgId).toBe(orgA);
    expect(result.deletedAt).toEqual(expect.any(String));

    // The org row is gone and a child (membership) cascaded with it.
    expect(await countIn(orgA, "orgs")).toBe(0);
    expect(await countIn(orgA, "memberships")).toBe(0);

    // The WORM audit chain is PRESERVED, org.deleted is appended, and the chain still verifies.
    const chain = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    expect(chain.map((r) => r.action)).toEqual(["org.created", "endpoint.created", "org.deleted"]);
    const verified = await verifyAuditChain(key, orgA, chain);
    expect(verified.ok).toBe(true);

    // A durable R2 purge job was enqueued for the deleted org.
    const [job] = await withTenant(
      app,
      orgA,
      (tx) => tx<{ status: string; requested_by: string; objects_purged: string }[]>`
        select status, requested_by, objects_purged from org_deletions where org_id = ${orgA}`,
    );
    expect(job.status).toBe("purging");
    expect(job.requested_by).toBe(formatAuditActor(userActor(ownerId)));
    expect(Number(job.objects_purged)).toBe(0);

    // The control org is fully intact.
    expect(await countIn(orgB, "orgs")).toBe(1);
    expect(await countIn(orgB, "memberships")).toBe(1);
  });

  it("rolls back cleanly (no orphan audit row or purge job) when the org does not exist", async () => {
    const ghost = randomUUID();
    await expect(
      deleteOrgWithAudit(app, { orgId: ghost, actor: userActor("x") }, key),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
    expect(await countIn(ghost, "org_deletions")).toBe(0);
    expect(await countIn(ghost, "audit_log")).toBe(0);
  });
});

describe("isOrgOwner", () => {
  it("is true only for an owner membership", async () => {
    const ownerId = `u_own_${randomUUID().slice(0, 8)}`;
    const memberId = `u_mem_${randomUUID().slice(0, 8)}`;
    await seedUser(ownerId);
    await seedUser(memberId);
    const orgId = await seedOrg("owner-check", ownerId);
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${memberId}, ${"member"})`,
    );

    expect(await isOrgOwner(app, ownerId, orgId)).toBe(true);
    expect(await isOrgOwner(app, memberId, orgId)).toBe(false);
    expect(await isOrgOwner(app, "u_nobody", orgId)).toBe(false);
  });
});

describe("purge drain (webhook_purge)", () => {
  it("claims outstanding jobs, advances the resume cursor, and completes them", async () => {
    const u = `u_drain_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const o1 = await seedOrg("drain-1", u);
    const o2 = await seedOrg("drain-2", u);
    await deleteOrgWithAudit(app, { orgId: o1, actor: userActor(u) }, key);
    await deleteOrgWithAudit(app, { orgId: o2, actor: userActor(u) }, key);

    // Both jobs are outstanding and unstarted (cursor null).
    const claimed = await claimPurgeJobs(purge, 10);
    const ids = claimed.map((j) => j.orgId);
    expect(ids).toEqual(expect.arrayContaining([o1, o2]));
    expect(claimed.every((j) => j.cursor === null)).toBe(true);

    // Advance o1 mid-prefix (not done): the resume cursor persists, job still outstanding.
    await advancePurgeJob(purge, { orgId: o1, cursor: "cur-1", deltaObjects: 500, done: false });
    const mid = (await claimPurgeJobs(purge, 10)).find((j) => j.orgId === o1);
    expect(mid?.cursor).toBe("cur-1");

    // Finish o1: it drops out of the outstanding set and records completion + the running total.
    await advancePurgeJob(purge, { orgId: o1, cursor: null, deltaObjects: 300, done: true });
    const afterIds = (await claimPurgeJobs(purge, 10)).map((j) => j.orgId);
    expect(afterIds).not.toContain(o1);
    expect(afterIds).toContain(o2);

    // Read the full row via the app (which can see all columns of its own org's job) — the drain
    // role deliberately can't SELECT purge_completed_at.
    const [done] = await withTenant(
      app,
      o1,
      (tx) => tx<{ status: string; objects_purged: string; done_at: string | null }[]>`
        select status, objects_purged, purge_completed_at as done_at
        from org_deletions where org_id = ${o1}`,
    );
    expect(done.status).toBe("completed");
    expect(Number(done.objects_purged)).toBe(800);
    expect(done.done_at).not.toBeNull();
  });

  it("holds least privilege: SELECT+UPDATE org_deletions only, no tenant-table access, non-super", async () => {
    // Both SELECT and UPDATE are COLUMN-level (least privilege): the drain reads org_id but NOT the
    // cross-tenant requested_by actor, and updates the drain columns but NOT org_id (a job can never
    // be reassigned to another org). No INSERT, no DELETE.
    const [g] = await owner<
      {
        selOrgId: boolean;
        selReqBy: boolean;
        ins: boolean;
        del: boolean;
        updStatus: boolean;
        updOrgId: boolean;
      }[]
    >`
      select
        has_column_privilege(${DB_ROLES.purge}, 'org_deletions', 'org_id', 'SELECT') as "selOrgId",
        has_column_privilege(${DB_ROLES.purge}, 'org_deletions', 'requested_by', 'SELECT') as "selReqBy",
        has_table_privilege(${DB_ROLES.purge}, 'org_deletions', 'INSERT') as ins,
        has_table_privilege(${DB_ROLES.purge}, 'org_deletions', 'DELETE') as del,
        has_column_privilege(${DB_ROLES.purge}, 'org_deletions', 'status', 'UPDATE') as "updStatus",
        has_column_privilege(${DB_ROLES.purge}, 'org_deletions', 'org_id', 'UPDATE') as "updOrgId"`;
    expect(g).toEqual({
      selOrgId: true,
      selReqBy: false,
      ins: false,
      del: false,
      updStatus: true,
      updOrgId: false,
    });

    for (const table of ["events", "orgs", "audit_log", "api_keys"]) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.purge}, ${table}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }

    const [r] = await owner<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = ${DB_ROLES.purge}`;
    expect(r).toEqual({ super: false, bypass: false });
  });
});

describe("org_deletions RLS boundary (the anti-forgery gate)", () => {
  it("blocks a tenant from enqueuing a purge job for a DIFFERENT org", async () => {
    // This is the load-bearing security property: forging orgB's job would let the drain destroy
    // orgB's R2 payloads. The insert `with check (org_id = current_org_id())` must reject it.
    const u = `u_forge_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgA = await seedOrg("forge-a", u);
    const orgB = await seedOrg("forge-b", u);
    await expect(
      withTenant(
        app,
        orgA,
        (tx) => tx`insert into org_deletions (org_id, requested_by) values (${orgB}, ${"evil"})`,
      ),
    ).rejects.toThrow();
    expect(await countIn(orgB, "org_deletions")).toBe(0);
  });

  it("a tenant cannot read another org's purge job", async () => {
    const u = `u_read_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgA = await seedOrg("read-a", u);
    const orgB = await seedOrg("read-b", u);
    await deleteOrgWithAudit(app, { orgId: orgB, actor: userActor(u) }, key); // orgB now has a purge job
    const visibleFromA = await withTenant(
      app,
      orgA,
      async (tx) =>
        (
          await tx<
            { n: number }[]
          >`select count(*)::int as n from org_deletions where org_id = ${orgB}`
        )[0].n,
    );
    expect(visibleFromA).toBe(0);
  });

  it("webhook_app can INSERT+SELECT the job but never UPDATE or DELETE it (drain-only)", async () => {
    const [g] = await owner<{ ins: boolean; sel: boolean; upd: boolean; del: boolean }[]>`
      select
        has_table_privilege(${DB_ROLES.app}, 'org_deletions', 'INSERT') as ins,
        has_table_privilege(${DB_ROLES.app}, 'org_deletions', 'SELECT') as sel,
        has_table_privilege(${DB_ROLES.app}, 'org_deletions', 'UPDATE') as upd,
        has_table_privilege(${DB_ROLES.app}, 'org_deletions', 'DELETE') as del`;
    expect(g).toEqual({ ins: true, sel: true, upd: false, del: false });
  });
});
