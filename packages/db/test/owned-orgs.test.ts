import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { classifyOwnedOrgs } from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The CROSS-ORG last-owner census (Lane 2.1b). The 2.1 guard only ever censused the user's PERSONAL org,
// because RLS made a cross-org "orgs I own" query impossible — and that was complete only while no shared
// org could exist. Invites shipped, so it isn't anymore:
//
//   Alice invites Bob as OWNER of her org. Bob accepts. Alice demotes herself (allowed — another owner
//   remains). Bob is now the SOLE owner of an org that is NOT his session org. Bob deletes his account: the
//   old guard censuses only Bob's personal org, passes, and the identity delete then cascades his membership
//   away GLOBALLY — leaving Alice's org with ZERO owners. Unreachable by RLS forever, still billed, and its
//   failure alerts go nowhere.
//
// 2.4a's user_org_directory made the cross-org read possible. classifyOwnedOrgs is that census.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;

async function seedUser(id: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@acme.test`}, ${true}, now())`;
}

async function seedOrg(name: string, ownerUserId: string): Promise<string> {
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name,
    ownerUserId,
    auditKey: await testAuditKey(),
  });
  return id;
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`,
  );
}

async function setRole(orgId: string, userId: string, role: string): Promise<void> {
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`update memberships set role = ${role} where org_id = ${orgId} and user_id = ${userId}`,
  );
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("classifyOwnedOrgs", () => {
  it("FLAGS the org an account deletion would orphan — even though it is not the user's own org", async () => {
    // The exact live scenario spelled out above.
    const alice = `u_al_${randomUUID().slice(0, 8)}`;
    const bob = `u_bo_${randomUUID().slice(0, 8)}`;
    const carol = `u_ca_${randomUUID().slice(0, 8)}`;
    await seedUser(alice);
    await seedUser(bob);
    await seedUser(carol);

    const alicesOrg = await seedOrg("Alice Co", alice);
    await addMember(alicesOrg, carol, "member"); // a bystander who would be stranded
    await addMember(alicesOrg, bob, "owner"); // Bob accepts an OWNER invite
    await setRole(alicesOrg, alice, "member"); // Alice steps down — Bob is now the sole owner
    const bobsOwn = await seedOrg("Bob Personal", bob); // …and Bob still has his own solo org

    const { wouldOrphan, soleOwnedSolo } = await classifyOwnedOrgs(app, bob);

    // Deleting Bob's account must be REFUSED: Alice's org would be left ownerless.
    expect(wouldOrphan.map((o) => o.orgId)).toEqual([alicesOrg]);
    expect(wouldOrphan[0]?.name).toBe("Alice Co");
    // Bob's own solo org is safe to erase with him — nobody else is in it.
    expect(soleOwnedSolo.map((o) => o.orgId)).toEqual([bobsOwn]);
  });

  it("treats a SOLO org (no other members) as safe to erase, not an orphan risk", async () => {
    const dana = `u_da_${randomUUID().slice(0, 8)}`;
    await seedUser(dana);
    const solo = await seedOrg("Dana Solo", dana);

    const { wouldOrphan, soleOwnedSolo } = await classifyOwnedOrgs(app, dana);
    expect(wouldOrphan).toEqual([]);
    expect(soleOwnedSolo.map((o) => o.orgId)).toEqual([solo]);
  });

  it("ignores orgs where ANOTHER owner remains — nothing is orphaned by leaving", async () => {
    const eve = `u_ev_${randomUUID().slice(0, 8)}`;
    const frank = `u_fr_${randomUUID().slice(0, 8)}`;
    await seedUser(eve);
    await seedUser(frank);
    const shared = await seedOrg("Shared", eve);
    await addMember(shared, frank, "owner"); // two owners

    const { wouldOrphan, soleOwnedSolo } = await classifyOwnedOrgs(app, eve);
    expect(wouldOrphan).toEqual([]);
    expect(soleOwnedSolo).toEqual([]); // not solo-owned either — Frank still owns it
  });

  it("ignores orgs the user is merely a MEMBER of — they orphan nothing by leaving", async () => {
    const gina = `u_gi_${randomUUID().slice(0, 8)}`;
    const host = `u_ho_${randomUUID().slice(0, 8)}`;
    await seedUser(gina);
    await seedUser(host);
    const hosted = await seedOrg("Hosted", host);
    await addMember(hosted, gina, "member");

    const { wouldOrphan, soleOwnedSolo } = await classifyOwnedOrgs(app, gina);
    expect(wouldOrphan).toEqual([]);
    expect(soleOwnedSolo).toEqual([]);
  });
});
