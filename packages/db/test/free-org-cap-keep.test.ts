import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { listOwnedOrgsForCap, setOrgFreeCapKeep } from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The picker's own read + write (PR2b slice 5), run as webhook_app exactly as a request would: enumerate
// cross-org under the user GUC (user_org_directory), then read/write per-org under each org's tenant context.
// Real Postgres, so the RLS that makes this the ONLY legal shape actually applies.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let admin: Sql;

async function seedUser(): Promise<string> {
  const uid = randomUUID();
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${uid}, ${uid}, ${`${uid}@t.test`}, ${true}, now())`;
  return uid;
}

async function seedOrg(uid: string, name = "o"): Promise<string> {
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name,
    ownerUserId: uid,
    auditKey: await testAuditKey(),
  });
  return id;
}

const paid = (orgId: string) => admin`
  insert into billing_subscriptions
    (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
  values (${orgId}, ${"sub_" + orgId.slice(0, 8)}, ${"price_pro"}, ${"active"},
          ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;

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

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await admin?.end();
  await pg?.stop();
});

describe("listOwnedOrgsForCap", () => {
  it("returns every OWNED org with the state the cap decision turns on", async () => {
    const uid = await seedUser();
    const free = await seedOrg(uid, "Free one");
    const upgraded = await seedOrg(uid, "Paid one");
    await paid(upgraded);

    const views = await listOwnedOrgsForCap(app, uid);
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.orgId === free)).toMatchObject({
      name: "Free one",
      isFree: true,
      status: "active",
      keepRequestedAt: null,
      graceUntil: null,
    });
    // A paid org is shown but is never at risk — the cap only counts free ones.
    expect(views.find((v) => v.orgId === upgraded)).toMatchObject({
      name: "Paid one",
      isFree: false,
    });
  });

  it("excludes orgs the user is only a MEMBER of — the cap counts what you OWN", async () => {
    const ownerUid = await seedUser();
    const memberUid = await seedUser();
    const org = await seedOrg(ownerUid);
    await admin`
      insert into memberships (org_id, user_id, role) values (${org}, ${memberUid}, ${"member"})`;

    expect(await listOwnedOrgsForCap(app, memberUid)).toEqual([]);
    expect((await listOwnedOrgsForCap(app, ownerUid)).map((v) => v.orgId)).toEqual([org]);
  });

  it("reflects a keep mark and a grace deadline once they're set", async () => {
    const uid = await seedUser();
    const org = await seedOrg(uid);
    await admin`
      update orgs set free_org_cap_grace_until = '2026-08-01T00:00:00Z' where id = ${org}`;
    await setOrgFreeCapKeep(app, org, uid, true);

    const [v] = await listOwnedOrgsForCap(app, uid);
    expect(v!.keepRequestedAt).toBeInstanceOf(Date);
    expect(v!.graceUntil?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("shows NOTHING for a user with no orgs (never throws on the empty case)", async () => {
    expect(await listOwnedOrgsForCap(app, await seedUser())).toEqual([]);
  });
});

describe("setOrgFreeCapKeep", () => {
  it("marks and unmarks, and unmarking clears the timestamp rather than zeroing it", async () => {
    const uid = await seedUser();
    const org = await seedOrg(uid);

    await setOrgFreeCapKeep(app, org, uid, true);
    expect((await listOwnedOrgsForCap(app, uid))[0]!.keepRequestedAt).toBeInstanceOf(Date);

    await setOrgFreeCapKeep(app, org, uid, false);
    expect((await listOwnedOrgsForCap(app, uid))[0]!.keepRequestedAt).toBeNull();
  });

  it("is idempotent — re-marking an already-marked org is harmless", async () => {
    const uid = await seedUser();
    const org = await seedOrg(uid);
    await setOrgFreeCapKeep(app, org, uid, true);
    await setOrgFreeCapKeep(app, org, uid, true);
    expect((await listOwnedOrgsForCap(app, uid))[0]!.keepRequestedAt).toBeInstanceOf(Date);
  });

  it("touches ONLY the addressed org — the write is tenant-scoped, one org per transaction", async () => {
    // RLS gives webhook_app no cross-org write (`orgs_update` is `id = current_org_id()`), which is exactly
    // why a picker saving N changes is N transactions. Prove the blast radius really is one row.
    const uid = await seedUser();
    const a = await seedOrg(uid);
    const b = await seedOrg(uid);

    await setOrgFreeCapKeep(app, a, uid, true);

    const views = await listOwnedOrgsForCap(app, uid);
    expect(views.find((v) => v.orgId === a)!.keepRequestedAt).toBeInstanceOf(Date);
    expect(views.find((v) => v.orgId === b)!.keepRequestedAt).toBeNull();
  });

  it("does NOT itself authorize — RLS scopes this write to one org, it does not check who you are", async () => {
    // Pinning the sharp edge deliberately, because the naive reading of "it's RLS'd" is wrong here.
    // `withTenant` sets the org GUC FROM THE ARGUMENT, and `orgs_update` is `id = current_org_id()` — so RLS
    // guarantees the write lands in the named org and nowhere else. It says nothing about whether the caller
    // may name that org. Passing a stranger's org id therefore SUCCEEDS at this layer.
    //
    // That is why `setOrgKeepAction` gates on `isOrgOwner` before calling this, and why that gate has its own
    // test. If this function ever grows an internal ownership check, this test should be the thing that
    // changes — not silently kept as reassurance it was never providing.
    const mine = await seedUser();
    const theirs = await seedUser();
    const myOrg = await seedOrg(mine);
    const theirOrg = await seedOrg(theirs);

    await setOrgFreeCapKeep(app, theirOrg, mine, true); // no error: scoped, not authorized
    expect((await listOwnedOrgsForCap(app, theirs))[0]!.keepRequestedAt).toBeInstanceOf(Date);
    // What RLS DID buy: the blast radius is exactly the named org — my org is untouched.
    expect(
      (await listOwnedOrgsForCap(app, mine)).find((v) => v.orgId === myOrg)!.keepRequestedAt,
    ).toBeNull();
  });
});
