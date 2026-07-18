import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, withUser, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createOrgWithOwner, isOrgDeliveryHeld, listUserOrgs, readUserProfile } from "../src/orgs";
import { testAuditKey } from "./audit-key";
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
    auditKey: await testAuditKey(),
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

  it("reports a freshly created org as active with no suspension reason", async () => {
    // The suspend columns (0083) default to active/null at creation; the directory threads them through so the
    // read gate can tell a live org from a suspended one without a second query.
    const uid = `u_act_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const org = await seedOrg("Active Org", uid);
    expect((await listUserOrgs(app, uid)).find((o) => o.orgId === org)).toMatchObject({
      status: "active",
      suspendedReason: null,
    });
  });

  it("threads status + reason once an org is suspended", async () => {
    const uid = `u_susp_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const org = await seedOrg("Suspended Org", uid);
    // The reconciler owns the write path (a later slice); here we simulate the effect under the org's tenant
    // context (the `orgs` UPDATE policy is `id = current_org_id()`, so it must run inside withTenant).
    await withTenant(
      app,
      org,
      (tx) => tx`
        update orgs set status = 'suspended', suspended_reason = 'free_org_cap', suspended_at = now()
        where id = ${org}`,
    );

    const seen = (await listUserOrgs(app, uid)).find((o) => o.orgId === org);
    expect(seen).toMatchObject({ status: "suspended", suspendedReason: "free_org_cap" });
  });

  it("HIDES a deleting org — user_org_directory filters status='deleting', so the read gate 404s it (#665)", async () => {
    const uid = `u_del_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const active = await seedOrg("Active Org", uid);
    const deleting = await seedOrg("Deleting Org", uid);
    await withTenant(
      app,
      deleting,
      (tx) => tx`update orgs set status = 'deleting', deleting_at = now() where id = ${deleting}`,
    );

    const orgIds = (await listUserOrgs(app, uid)).map((o) => o.orgId);
    expect(orgIds).toContain(active);
    expect(orgIds).not.toContain(deleting); // vanished from the directory the read gate resolves through
  });
});

describe("isOrgDeliveryHeld — the outbound-delivery gate reads it under the tenant GUC", () => {
  it("is false for an active org and true once suspended", async () => {
    const uid = `u_gate_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const org = await seedOrg("Gate Org", uid);

    expect(await withTenant(app, org, (tx) => isOrgDeliveryHeld(tx))).toBe(false);

    await withTenant(
      app,
      org,
      (tx) => tx`
        update orgs set status = 'suspended', suspended_reason = 'free_org_cap', suspended_at = now()
        where id = ${org}`,
    );

    expect(await withTenant(app, org, (tx) => isOrgDeliveryHeld(tx))).toBe(true);
  });

  it("is true for a DELETING org, so it egresses nothing while being reaped (#665)", async () => {
    const uid = `u_gate_del_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const org = await seedOrg("Gate Del Org", uid);

    await withTenant(
      app,
      org,
      (tx) => tx`update orgs set status = 'deleting', deleting_at = now() where id = ${org}`,
    );
    expect(await withTenant(app, org, (tx) => isOrgDeliveryHeld(tx))).toBe(true);
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

  it("the DIRECTORY ITSELF is deny-by-default: no user GUC (or a blank one) → no rows", async () => {
    // The load-bearing claim of the whole design: user_org_directory() takes NO argument, so it cannot be
    // pointed at another user — it reads current_app_user(). If an unset GUC returned rows, that function
    // would be a cross-org read available to webhook_app for the asking. Assert the function, not just the
    // tables around it.
    const ivan = `u_i_${randomUUID().slice(0, 8)}`;
    await seedUser(ivan);
    await seedOrg("Ivan Org", ivan);

    // No withUser at all → current_app_user() is NULL.
    expect(await app<{ org_id: string }[]>`select org_id from user_org_directory()`).toEqual([]);

    // …and a BLANK GUC is NULL too (the nullif in current_app_user), not an empty-string match.
    const blank = await app.begin(async (tx) => {
      await tx`select set_config('app.current_user', '', true)`;
      return tx<{ org_id: string }[]>`select org_id from user_org_directory()`;
    });
    expect(blank).toEqual([]);
  });

  it("orders the directory oldest-first, so the personal org leads and the order is stable", async () => {
    const jo = `u_j_${randomUUID().slice(0, 8)}`;
    await seedUser(jo);
    const first = await seedOrg("Jo First", jo);
    const second = await seedOrg("Jo Second", jo);

    // Not sorted by the test — the ORDER is the assertion (the switcher shows them in this order).
    expect((await listUserOrgs(app, jo)).map((o) => o.orgId)).toEqual([first, second]);
  });

  it("webhook_app CANNOT read across orgs directly, even inside withUser — only the directory can", async () => {
    // The heart of the design. A permissive `user_id = current_app_user()` policy on webhook_app would make
    // this bare read return BOTH orgs — and would thereby make every unqualified membership read in the
    // codebase cross-org (the Lane S.4 escalation: a team `member` who owns their personal org reading back
    // `owner`). webhook_app has no such policy, so the raw read sees NOTHING; the capability lives only in
    // the SECURITY DEFINER directory, which is bounded to the caller's own rows.
    const hana = `u_h_${randomUUID().slice(0, 8)}`;
    await seedUser(hana);
    const a = await seedOrg("Hana A", hana);
    const b = await seedOrg("Hana B", hana);

    const raw = await withUser(
      app,
      hana,
      (tx) => tx<{ org_id: string }[]>`select org_id from memberships`,
    );
    expect(raw).toEqual([]); // no cross-org leak through the request-path role

    // …and the sanctioned path still answers the question.
    expect((await listUserOrgs(app, hana)).map((o) => o.orgId).sort()).toEqual([a, b].sort());
  });
});

describe("readUserProfile — the ONLY path webhook_app has to an identity", () => {
  // This exists because of a bug that shipped past a green unit suite.
  //
  // The signup bootstrap's self-heal is handed a bare userId, so to name a user's personal org after them it
  // has to read `"user"`. The first attempt simply ran `select name, email from "user"` on the webhook_app
  // client — and webhook_app has NO grant on that table, deliberately (it is Better Auth's global identity
  // table, not row-level-secured, with no org column to police; rls.test.ts asserts the refusal outright). In
  // production that throws `permission denied`, which would have aborted the bootstrap and left the user with
  // NO ORG AT ALL — strictly worse than the bug being fixed.
  //
  // Every unit test stubbed the loader, so none of them could see it. Only a real Postgres, connecting as the
  // real role, can. That is what this is.
  it("returns the caller's own profile under the app role", async () => {
    const id = `u_prof_${randomUUID().slice(0, 8)}`;
    await seedUser(id);

    const profile = await readUserProfile(app, id);

    expect(profile).toEqual({ name: id, email: `${id}@acme.test` });
  });

  it("returns null for a user that does not exist", async () => {
    expect(await readUserProfile(app, `u_missing_${randomUUID().slice(0, 8)}`)).toBeNull();
  });

  it("cannot be reached by reading the identity table directly — the grant is absent", async () => {
    // The whole point of the definer. If this ever stops throwing, the confinement has collapsed and
    // webhook_app can enumerate every user in the system.
    await expect(app`select name, email from "user" limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("yields NOTHING when the user GUC is unset — deny-by-default, not the whole table", async () => {
    const id = `u_guc_${randomUUID().slice(0, 8)}`;
    await seedUser(id);

    // Call the function WITHOUT withUser(): current_app_user() is NULL, so `u.id = NULL` matches no row.
    const rows = await app`select name, email from current_user_profile()`;

    expect(rows.length).toBe(0);
  });

  it("cannot be pointed at another user — it takes no argument", async () => {
    const mine = `u_mine_${randomUUID().slice(0, 8)}`;
    const theirs = `u_theirs_${randomUUID().slice(0, 8)}`;
    await seedUser(mine);
    await seedUser(theirs);

    // Scoped to `mine`, the function returns `mine` and only `mine`. There is no argument to smuggle
    // `theirs` in through: the identity comes from the GUC, which the application sets from a
    // server-authenticated id.
    const rows = await withUser(
      app,
      mine,
      (tx) => tx<{ name: string }[]>`select name, email from current_user_profile()`,
    );

    expect(rows.map((r) => r.name)).toEqual([mine]);
  });
});

describe("the directory resolves a slug — the security keystone of /org/{slug}", () => {
  // A GLOBAL slug -> org_id lookup is STRUCTURALLY IMPOSSIBLE for webhook_app: its only SELECT policy on
  // `orgs` is `id = current_org_id()`, so `select id from orgs where slug = $1` returns zero rows — silently.
  // And the "obvious" fix (a permissive policy so any slug can be looked up) is exactly the escalation
  // migration 0067 exists to prevent, because Postgres policies OR together.
  //
  // So the slug is resolved INSIDE THE CALLER'S OWN DIRECTORY. That makes slug resolution and the membership
  // check THE SAME OPERATION — they cannot drift apart, because there is only one of them — and it means a
  // slug you don't belong to is indistinguishable from one that doesn't exist. No enumeration oracle, by
  // construction rather than by a check someone has to remember.
  it("returns the current slug for each of the caller's orgs", async () => {
    const uid = `u_slug_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const slug = `keystone-${randomUUID().slice(0, 6)}`;
    const { id } = await createOrgWithOwner(app, {
      slug,
      name: "Keystone",
      ownerUserId: uid,
      auditKey: await testAuditKey(),
    });

    const orgs = await listUserOrgs(app, uid);

    expect(orgs.find((o) => o.orgId === id)?.slug).toBe(slug);
  });

  it("returns FORMER slugs too, so an old link still resolves to the org that owns it", async () => {
    const uid = `u_hist_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const first = `oldname-${randomUUID().slice(0, 6)}`;
    const second = `newname-${randomUUID().slice(0, 6)}`;
    const { id } = await createOrgWithOwner(app, {
      slug: first,
      name: "Renamed",
      ownerUserId: uid,
      auditKey: await testAuditKey(),
    });

    // The DB records the retirement itself — the app cannot write org_slug_history (see org-slug.test.ts).
    await withTenant(app, id, (tx) => tx`update orgs set slug = ${second} where id = ${id}`);

    const org = (await listUserOrgs(app, uid)).find((o) => o.orgId === id);

    expect(org?.slug).toBe(second);
    // ⚠️ Assert it is an ARRAY, not merely that it "contains" the slug.
    //
    // `former_slugs` was declared `text[]` and postgres.js — with `fetch_types: false` — handed it back as the
    // RAW LITERAL STRING "{oldname-abc}". `expect(aString).toContain("oldname-abc")` passes, because toContain
    // matches a SUBSTRING when the subject is a string. So this test was green over a value of entirely the
    // wrong type, and `formerSlugs.some(...)` threw on the first real browser request. Pin the type.
    expect(Array.isArray(org?.formerSlugs)).toBe(true);
    expect(org?.formerSlugs).toEqual([first]);
  });

  it("an org that RECLAIMS a former slug does not report its own current slug as former", async () => {
    // The reclaim path leaves a history row for the slug the org is now using again. Without a
    // `h.slug <> o.slug` filter the directory would report the CURRENT slug as a FORMER one — and the
    // resolver would then treat a canonical URL as a stale one to redirect away from.
    const uid = `u_recl_${randomUUID().slice(0, 8)}`;
    await seedUser(uid);
    const original = `boomerang-${randomUUID().slice(0, 6)}`;
    const away = `elsewhere-${randomUUID().slice(0, 6)}`;
    const { id } = await createOrgWithOwner(app, {
      slug: original,
      name: "Boomerang",
      ownerUserId: uid,
      auditKey: await testAuditKey(),
    });

    await withTenant(app, id, (tx) => tx`update orgs set slug = ${away} where id = ${id}`);
    await withTenant(app, id, (tx) => tx`update orgs set slug = ${original} where id = ${id}`); // back

    const org = (await listUserOrgs(app, uid)).find((o) => o.orgId === id);

    expect(org?.slug).toBe(original);
    expect(Array.isArray(org?.formerSlugs)).toBe(true);
    expect(org?.formerSlugs).toEqual([away]); // and NOT its own current slug
  });

  it("does NOT leak a slug you are not a member of — the resolver simply cannot see it", async () => {
    const mine = `u_a_${randomUUID().slice(0, 8)}`;
    const theirs = `u_b_${randomUUID().slice(0, 8)}`;
    await seedUser(mine);
    await seedUser(theirs);
    const secret = `theirsecret-${randomUUID().slice(0, 6)}`;
    await createOrgWithOwner(app, {
      slug: secret,
      name: "Theirs",
      ownerUserId: theirs,
      auditKey: await testAuditKey(),
    });

    // The whole resolution surface, for `mine`. Their slug is not in it — so `/org/theirsecret-…` is, to me,
    // exactly as non-existent as a slug nobody ever registered. There is nothing to distinguish, so there is
    // nothing to probe.
    const resolvable = (await listUserOrgs(app, mine)).flatMap((o) => [o.slug, ...o.formerSlugs]);

    expect(resolvable).not.toContain(secret);
  });
});
