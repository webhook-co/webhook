import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, withUser, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createOrgWithOwner, listUserOrgs } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// listUserOrgs (Lane 2.4) — "which orgs do I belong to?", the read multi-org needs and which the org-scoped
// RLS policies structurally cannot answer. Migration 0067 adds the user-scoped policies; these tests pin
// that they reveal EXACTLY the caller's own memberships and nothing else.

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
  });
  return id;
}

/** Add an existing user to an org at `role` (the shape acceptInvite produces). */
async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`,
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

describe("listUserOrgs", () => {
  it("returns EVERY org the user belongs to, with the org's name and their role", async () => {
    const alice = `u_a_${randomUUID().slice(0, 8)}`;
    const bob = `u_b_${randomUUID().slice(0, 8)}`;
    await seedUser(alice);
    await seedUser(bob);

    const own = await seedOrg("Alice Personal", alice); // alice = owner
    const team = await seedOrg("Acme Team", bob); // bob = owner
    await addMember(team, alice, "member"); // …alice invited in as a member

    const orgs = await listUserOrgs(app, alice);
    expect(orgs).toHaveLength(2);
    expect(orgs.find((o) => o.orgId === own)).toMatchObject({
      name: "Alice Personal",
      role: "owner",
    });
    // THE POINT of the whole lane: the invited org is now visible, so the CLI/MCP can land in it.
    expect(orgs.find((o) => o.orgId === team)).toMatchObject({ name: "Acme Team", role: "member" });
  });

  it("never reveals ANOTHER user's orgs", async () => {
    const carol = `u_c_${randomUUID().slice(0, 8)}`;
    const dave = `u_d_${randomUUID().slice(0, 8)}`;
    await seedUser(carol);
    await seedUser(dave);
    const carolsOrg = await seedOrg("Carol Only", carol);
    await seedOrg("Dave Only", dave);

    const orgs = await listUserOrgs(app, carol);
    expect(orgs.map((o) => o.orgId)).toEqual([carolsOrg]);
  });

  it("returns nothing for a user with no memberships", async () => {
    const nobody = `u_n_${randomUUID().slice(0, 8)}`;
    await seedUser(nobody);
    expect(await listUserOrgs(app, nobody)).toEqual([]);
  });
});

describe("the user-scoped policies are DENY-BY-DEFAULT", () => {
  it("reveals nothing when the user GUC is unset (a bare query sees no memberships)", async () => {
    const eve = `u_e_${randomUUID().slice(0, 8)}`;
    await seedUser(eve);
    await seedOrg("Eve Org", eve);

    // No withUser, no withTenant: current_app_user() and current_org_id() are both NULL.
    const rows = await app<{ user_id: string }[]>`select user_id from memberships`;
    expect(rows).toEqual([]);
    const orgRows = await app<{ id: string }[]>`select id from orgs`;
    expect(orgRows).toEqual([]);
  });

  it("does NOT widen the tenant-scoped read: inside withTenant you still see only that org", async () => {
    // The new policy is PERMISSIVE (OR'd). This pins that it only ever ADDS the caller's own rows — a
    // tenant-context query with an explicit org_id predicate is unchanged, which is what every existing
    // membership read relies on (Lane S.4 made them all org-qualified for exactly this reason).
    const frank = `u_f_${randomUUID().slice(0, 8)}`;
    const gina = `u_g_${randomUUID().slice(0, 8)}`;
    await seedUser(frank);
    await seedUser(gina);
    const franksOrg = await seedOrg("Frank Org", frank);
    const ginasOrg = await seedOrg("Gina Org", gina);

    const rows = await withTenant(
      app,
      franksOrg,
      (tx) => tx<{ org_id: string }[]>`select org_id from memberships where org_id = ${franksOrg}`,
    );
    expect(rows.map((r) => r.org_id)).toEqual([franksOrg]);
    expect(rows.some((r) => r.org_id === ginasOrg)).toBe(false);
  });

  it("withUser sees the user's rows across orgs WITHOUT any tenant context", async () => {
    const hana = `u_h_${randomUUID().slice(0, 8)}`;
    await seedUser(hana);
    const a = await seedOrg("Hana A", hana);
    const b = await seedOrg("Hana B", hana);

    const rows = await withUser(
      app,
      hana,
      (tx) => tx<{ org_id: string }[]>`select org_id from memberships`,
    );
    expect(rows.map((r) => r.org_id).sort()).toEqual([a, b].sort());
  });
});
