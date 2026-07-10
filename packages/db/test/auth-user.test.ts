import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { deleteUserIdentity, getAuthUserProfile } from "../src/auth-user";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Lane C A-SX-2a — getAuthUserProfile reads a better-auth user's display fields (name/email/image) for the
// session-exchange redeem. The `user` table is the GLOBAL identity realm (no tenant RLS); webhook_auth has
// DML on it (migration 0016). Read FRESH at redeem — never denormalized into the exchange ticket.

let pg: EphemeralPostgres;
let auth: Sql; // webhook_auth — the identity role
let owner: Sql; // seeds the better-auth "user" rows
let app: Sql; // webhook_app — seeds org-scoped rows (memberships, auth_grant) under RLS

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  auth = createClient(pg.urlFor({ role: DB_ROLES.auth }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await auth?.end();
  await owner?.end();
  await app?.end();
  await pg?.stop();
});

describe("getAuthUserProfile", () => {
  it("returns the name/email/image for an existing user (read as webhook_auth)", async () => {
    const id = `user_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "image", "updatedAt")
      values (${id}, ${"Dana Doe"}, ${`${id}@e.test`}, ${true}, ${"https://img.example/d.png"}, now())`;
    expect(await getAuthUserProfile(auth, id)).toEqual({
      name: "Dana Doe",
      email: `${id}@e.test`,
      image: "https://img.example/d.png",
    });
  });

  it("returns image: null when the user has no avatar", async () => {
    const id = `user_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
      values (${id}, ${"No Avatar"}, ${`${id}@e.test`}, ${true}, now())`;
    const profile = await getAuthUserProfile(auth, id);
    expect(profile).toEqual({ name: "No Avatar", email: `${id}@e.test`, image: null });
  });

  it("returns null for an unknown user id", async () => {
    expect(await getAuthUserProfile(auth, `user_${randomUUID()}`)).toBeNull();
  });
});

describe("deleteUserIdentity", () => {
  it("removes the user and cascades their memberships", async () => {
    const userId = `user_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
      values (${userId}, ${"Erase Me"}, ${`${userId}@e.test`}, ${true}, now())`;
    const orgId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o"}, ${"o"})`;
      await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`;
    });

    expect(await deleteUserIdentity(auth, userId)).toBe(true);

    expect(await getAuthUserProfile(auth, userId)).toBeNull();
    const memLeft = await withTenant(
      app,
      orgId,
      async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from memberships`)[0].n,
    );
    expect(memLeft).toBe(0); // the user's membership cascaded away with them
  });

  it("no longer blocks on auth_grant.approved_by — it nulls the reference (migration 0052)", async () => {
    const approver = `user_${randomUUID()}`;
    const grantee = `user_${randomUUID()}`;
    for (const u of [approver, grantee]) {
      await owner`
        insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
        values (${u}, ${u}, ${`${u}@e.test`}, ${true}, now())`;
    }
    const orgId = randomUUID();
    const grantId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"g"}, ${"g"})`;
      await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${grantee}, ${"member"})`;
      // a grant OWNED by `grantee`, APPROVED BY the `approver` we're about to erase.
      await tx`
        insert into auth_grant (id, org_id, user_id, status, auth_method, approved_by, approved_at)
        values (${grantId}, ${orgId}, ${grantee}, ${"active"}, ${"pkce_loopback"}, ${approver}, now())`;
    });

    // Before 0052 this raised a FK violation (NO ACTION); now it succeeds and nulls approved_by.
    expect(await deleteUserIdentity(auth, approver)).toBe(true);

    const approvedBy = await withTenant(
      app,
      orgId,
      async (tx) =>
        (
          await tx<{ approved_by: string | null }[]>`
            select approved_by from auth_grant where id = ${grantId}`
        )[0].approved_by,
    );
    expect(approvedBy).toBeNull();
  });

  it("returns false for a user that does not exist", async () => {
    expect(await deleteUserIdentity(auth, `user_${randomUUID()}`)).toBe(false);
  });
});
