import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { findOwnersOverFreeCap } from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The AUTHORITATIVE free-org-cap detector (PR2b slice 2): across ALL users, find every owner of more than
// `cap` FREE orgs. This is the cross-user question the per-tenant roles can't answer — confined to the
// `owners_over_free_org_cap` SECURITY DEFINER function whose EXECUTE is granted ONLY to webhook_capreconciler.
// Driven against real Postgres so the definer + the EXECUTE-grant fence run exactly as production does.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — the request-path role; MUST NOT be able to run the detector
let owner: Sql;
let admin: Sql;
let reconciler: Sql; // webhook_capreconciler — the only role granted EXECUTE

async function seedUser(id: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@acme.test`}, ${true}, now())`;
}

async function seedOrg(ownerUserId: string): Promise<string> {
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "o",
    ownerUserId,
    auditKey: await testAuditKey(),
  });
  return id;
}

/** Create an org and pin its created_at, so oldest-first ordering is deterministic (now() can tie). */
async function seedOrgAt(ownerUserId: string, createdAt: string): Promise<string> {
  const id = await seedOrg(ownerUserId);
  await admin`update orgs set created_at = ${createdAt} where id = ${id}`;
  return id;
}

async function addOwner(orgId: string, userId: string): Promise<void> {
  await seedUser(userId);
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`,
  );
}

async function makePaid(orgId: string): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 8)}, ${"price_pro"}, ${"active"},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;
}

const CAP = 2;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
  reconciler = createClient(pg.urlFor({ role: DB_ROLES.capReconciler }));
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from billing_subscriptions`;
  await admin`delete from memberships`;
  await admin`delete from orgs`;
  await admin`delete from "user"`;
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await admin?.end();
  await reconciler?.end();
  await pg?.stop();
});

describe("findOwnersOverFreeCap (owners_over_free_org_cap)", () => {
  it("returns an owner over the cap with ALL their free orgs, oldest-first", async () => {
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrgAt(u, "2026-01-01T00:00:00Z");
    const b = await seedOrgAt(u, "2026-02-01T00:00:00Z");
    const c = await seedOrgAt(u, "2026-03-01T00:00:00Z");

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    expect(over).toHaveLength(1);
    expect(over[0]!.userId).toBe(u);
    expect(over[0]!.freeOrgs.map((o) => o.orgId)).toEqual([a, b, c]); // oldest → newest
    expect(over[0]!.freeOrgs.every((o) => o.status === "active")).toBe(true);
  });

  it("does NOT return a user AT the cap", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u); // exactly CAP=2 free orgs
    expect(await findOwnersOverFreeCap(reconciler, CAP)).toEqual([]);
  });

  it("excludes PAID orgs from both the count and the returned list", async () => {
    // 2 free + 2 paid: only 2 free ⇒ NOT over the cap.
    const under = randomUUID();
    await seedUser(under);
    await seedOrg(under);
    await seedOrg(under);
    await makePaid(await seedOrg(under));
    await makePaid(await seedOrg(under));
    expect(await findOwnersOverFreeCap(reconciler, CAP)).toEqual([]);

    // 3 free + 1 paid: over the cap; the paid org must NOT appear in the returned free list.
    const over = randomUUID();
    await seedUser(over);
    const f1 = await seedOrg(over);
    const f2 = await seedOrg(over);
    const f3 = await seedOrg(over);
    const paid = await seedOrg(over);
    await makePaid(paid);

    const res = await findOwnersOverFreeCap(reconciler, CAP);
    const row = res.find((r) => r.userId === over)!;
    expect(row.freeOrgs.map((o) => o.orgId).sort()).toEqual([f1, f2, f3].sort());
    expect(row.freeOrgs.some((o) => o.orgId === paid)).toBe(false);
  });

  it("counts a CO-OWNED free org toward EACH owner (both can be over the cap)", async () => {
    // Alice: 2 solo + 1 shared = 3 free → over. Bob: only the shared = 1 free → under.
    const alice = randomUUID();
    const bob = randomUUID();
    await seedUser(alice);
    await seedOrg(alice);
    await seedOrg(alice);
    const shared = await seedOrg(alice);
    await addOwner(shared, bob); // co-owned

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    expect(over.map((o) => o.userId)).toEqual([alice]);
    expect(over[0]!.freeOrgs.some((o) => o.orgId === shared)).toBe(true);
  });

  it("returns a suspended org with its status/reason, so the reconciler can skip re-suspending it", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u);
    const third = await seedOrg(u);
    await withTenant(
      app,
      third,
      (tx) => tx`
        update orgs set status = 'suspended', suspended_reason = 'free_org_cap', suspended_at = now()
        where id = ${third}`,
    );

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    const seen = over[0]!.freeOrgs.find((o) => o.orgId === third)!;
    expect(seen).toMatchObject({ status: "suspended", suspendedReason: "free_org_cap" });
  });

  it("reveals NOTHING to webhook_app — the cross-user reach is confined to the reconciler role by RLS", async () => {
    // The confinement: the cross-org read rides role-targeted `..._capreconciler_select` policies that ONLY
    // webhook_capreconciler has. webhook_app can run the same query (it has table SELECT), but its RLS is
    // `org_id = current_org_id()` and there's no tenant GUC here, so it sees NO rows. A compromised web
    // request therefore can't turn this into a cross-user enumeration oracle — same over-cap owner, empty
    // result for webhook_app, full result for the reconciler.
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u);
    await seedOrg(u); // 3 free → over the cap

    expect(await findOwnersOverFreeCap(app, CAP)).toEqual([]); // request-path role: nothing
    expect((await findOwnersOverFreeCap(reconciler, CAP)).map((o) => o.userId)).toEqual([u]); // reconciler: sees it
  });
});
