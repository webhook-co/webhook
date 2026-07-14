import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { countOwnedFreeOrgs, isPersonalOrg, personalOrgId } from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The free-org creation cap's counting primitive + the org-centric personal-org guard. A user may own
// at most MAX_FREE_ORGS_PER_USER FREE orgs; PAID orgs are unlimited; every free org a user owns counts
// (per-owner, so a sockpuppet co-owner can't zero out the count). Driven against real Postgres so the
// cross-org listUserOrgs + per-org reads run under real RLS, exactly as production does.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let admin: Sql;

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

async function addOwner(orgId: string, userId: string): Promise<void> {
  await seedUser(userId);
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`,
  );
}

/** Attach a subscription of a given status to an org — admin bypasses the verified-Stripe-only RLS. */
async function makeSub(orgId: string, status = "active"): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 8)}, ${"price_pro"}, ${status},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;
}
/** Attach an ACTIVE (paid) subscription. */
const makePaid = (orgId: string) => makeSub(orgId, "active");

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from billing_subscriptions`;
  await admin`delete from memberships`;
  await admin`delete from orgs`;
  await admin`delete from "user"`;
});

// Stop the ephemeral cluster + close clients. On CI's SHARED Postgres a leaked database keeps its
// webhook_* role grants in pg_shdepend, pinning those cluster-global roles and making
// migrations.test.ts's down-all `DROP ROLE` fail. Every file that starts a cluster must stop it.
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await admin?.end();
  await pg?.stop();
});

describe("countOwnedFreeOrgs", () => {
  it("counts each Free org the user solely owns", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u);
    expect(await countOwnedFreeOrgs(app, u)).toBe(2);
  });

  it("does NOT count a paid org (only Free orgs count toward the cap)", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u); // free
    const paid = await seedOrg(u);
    await makePaid(paid);
    expect(await countOwnedFreeOrgs(app, u)).toBe(1);
  });

  it("does NOT count an org the user does not OWN (only member)", async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    await seedUser(alice);
    const org = await seedOrg(alice);
    // Bob joins Alice's org as a plain member.
    await seedUser(bob);
    await withTenant(
      app,
      org,
      (tx) =>
        tx`insert into memberships (org_id, user_id, role) values (${org}, ${bob}, ${"member"})`,
    );
    expect(await countOwnedFreeOrgs(app, bob)).toBe(0);
  });

  it("counts a CO-OWNED Free org toward EACH owner (no sockpuppet-co-owner bypass)", async () => {
    // Attribution is per-owner, NOT sole-owner: a farmer must not be able to zero out the count by
    // adding a throwaway co-owner to every org. So a co-owned free org counts toward BOTH owners.
    const alice = randomUUID();
    const bob = randomUUID();
    await seedUser(alice);
    const shared = await seedOrg(alice); // Alice's solo Free org
    await addOwner(shared, bob); // now co-owned (2 owners)
    expect(await countOwnedFreeOrgs(app, alice)).toBe(1);
    expect(await countOwnedFreeOrgs(app, bob)).toBe(1);
  });

  it("returns 0 for a user who owns nothing", async () => {
    const u = randomUUID();
    await seedUser(u);
    expect(await countOwnedFreeOrgs(app, u)).toBe(0);
  });

  it("uses the full entitlement matrix: trialing/past_due are PAID; canceled/unpaid/unknown are Free", async () => {
    // hasEntitledSubscription is the paid-vs-Free definition — it must match BILLING_ACTIVE_STATUSES
    // (active/trialing/past_due = entitled/paid), so any OTHER status still counts the org as Free.
    const u = randomUUID();
    await seedUser(u);
    const trialing = await seedOrg(u);
    await makeSub(trialing, "trialing"); // entitled → PAID → excluded
    const pastDue = await seedOrg(u);
    await makeSub(pastDue, "past_due"); // entitled → PAID → excluded
    const canceled = await seedOrg(u);
    await makeSub(canceled, "canceled"); // not entitled → FREE → included
    const unpaid = await seedOrg(u);
    await makeSub(unpaid, "unpaid"); // not entitled → FREE → included
    const unknown = await seedOrg(u);
    await makeSub(unknown, "incomplete_expired"); // not entitled → FREE → included
    // Of the 5, only trialing + past_due are entitled → 3 Free.
    expect(await countOwnedFreeOrgs(app, u)).toBe(3);
  });
});

describe("isPersonalOrg", () => {
  /** Create the deterministic personal org for a user (id === personalOrgId(userId)). */
  async function seedPersonalOrg(userId: string): Promise<string> {
    const orgId = personalOrgId(userId);
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"p-" + orgId.slice(0, 8)}, ${"me"})`;
      await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`;
    });
    return orgId;
  }

  it("is true for an org whose id is an owner's personalOrgId", async () => {
    const u = randomUUID();
    await seedUser(u);
    const p = await seedPersonalOrg(u);
    expect(await isPersonalOrg(app, p)).toBe(true);
  });

  it("stays true when a SECOND owner is added — org-centric, so a co-owner can't delete it", async () => {
    const u = randomUUID();
    await seedUser(u);
    const p = await seedPersonalOrg(u);
    await addOwner(p, randomUUID()); // a second owner joins the personal org
    // The guard keys on the org's OWN owners, not the caller: still personal.
    expect(await isPersonalOrg(app, p)).toBe(true);
  });

  it("is false for a regular team org (no owner's personalOrgId equals it)", async () => {
    const u = randomUUID();
    await seedUser(u);
    const team = await seedOrg(u); // random id, not a personalOrgId
    expect(await isPersonalOrg(app, team)).toBe(false);
  });
});
