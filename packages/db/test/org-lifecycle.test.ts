import { randomUUID } from "node:crypto";

import { importAuditKey, verifyAuditChain } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry, readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { deleteOrgWithAudit, isOrgOwner, OrgNotFoundError } from "../src/org-lifecycle";
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
      actor: ownerUserId,
      action: "org.created",
      target: null,
    });
    await appendAuditEntry(tx, key, {
      orgId,
      actor: ownerUserId,
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
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
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

    const result = await deleteOrgWithAudit(app, { orgId: orgA, actor: ownerId }, key);
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
    expect(job.requested_by).toBe(ownerId);
    expect(Number(job.objects_purged)).toBe(0);

    // The control org is fully intact.
    expect(await countIn(orgB, "orgs")).toBe(1);
    expect(await countIn(orgB, "memberships")).toBe(1);
  });

  it("rolls back cleanly (no orphan audit row or purge job) when the org does not exist", async () => {
    const ghost = randomUUID();
    await expect(deleteOrgWithAudit(app, { orgId: ghost, actor: "x" }, key)).rejects.toBeInstanceOf(
      OrgNotFoundError,
    );
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
