import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  completeOnboarding,
  deleteUserIdentity,
  getAuthUserProfile,
  readOnboardingState,
  updateUserName,
} from "../src/auth-user";
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
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"})`;
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
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"g-" + orgId.slice(0, 8)}, ${"g"})`;
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

// Onboarding state + completion. Both run as webhook_auth on the identity realm — webhook_app has no grant on
// the `user` table (migration 0068), which is exactly why these cross the boundary by RPC rather than a tenant
// query. Migration 0073 added firstName/lastName/onboardedAt.
describe("onboarding state", () => {
  async function seedUser(over: { firstName?: string; lastName?: string } = {}): Promise<string> {
    const id = `user_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "firstName", "lastName", "updatedAt")
      values (${id}, ${"Ada Lovelace"}, ${`${id}@e.test`}, ${true},
              ${over.firstName ?? null}, ${over.lastName ?? null}, now())`;
    return id;
  }

  it("reads a fresh user as NOT yet onboarded", async () => {
    const id = await seedUser({ firstName: "Ada", lastName: "Lovelace" });

    const state = await readOnboardingState(auth, id);

    expect(state).not.toBeNull();
    expect(state!.onboardedAt).toBeNull();
    expect(state!.firstName).toBe("Ada");
    expect(state!.lastName).toBe("Lovelace");
    expect(state!.createdAt).toBeInstanceOf(Date);
  });

  it("returns null for a user that does not exist", async () => {
    expect(await readOnboardingState(auth, `user_${randomUUID()}`)).toBeNull();
  });

  it("stamps onboardedAt and stores the corrected name in ONE write", async () => {
    const id = await seedUser();
    const at = new Date("2026-07-14T00:00:00.000Z");

    const wrote = await completeOnboarding(auth, {
      userId: id,
      firstName: "Grace",
      lastName: "Hopper",
      onboardedAt: at,
    });

    expect(wrote).toBe(true);
    const state = await readOnboardingState(auth, id);
    expect(state!.firstName).toBe("Grace");
    expect(state!.lastName).toBe("Hopper");
    // onboardedAt is now SET — this is the gate flipping from "show onboarding" to "done".
    expect(state!.onboardedAt).toEqual(at);
  });

  // An absent last name is absent, not blank — so it reads the same as a user who never had one.
  it("stores an empty name field as NULL, not an empty string", async () => {
    const id = await seedUser();

    await completeOnboarding(auth, {
      userId: id,
      firstName: "Prince",
      lastName: "   ",
      onboardedAt: new Date(),
    });

    expect((await readOnboardingState(auth, id))!.lastName).toBeNull();
  });

  // The corrected name must reach the composite `name`, because that is what the app renders (account page,
  // avatar, greeting) — not the first/last split. A user who fixes their name in onboarding must see it.
  it("updates the composite display name to the corrected first + last", async () => {
    const id = await seedUser(); // seeded as "Ada Lovelace"

    await completeOnboarding(auth, {
      userId: id,
      firstName: "Grace",
      lastName: "Hopper",
      onboardedAt: new Date(),
    });

    expect((await readOnboardingState(auth, id))!.name).toBe("Grace Hopper");
  });

  it("uses just the first name as the composite when there is no last name", async () => {
    const id = await seedUser();
    await completeOnboarding(auth, {
      userId: id,
      firstName: "Prince",
      lastName: "",
      onboardedAt: new Date(),
    });
    expect((await readOnboardingState(auth, id))!.name).toBe("Prince");
  });

  // `name` is NOT NULL in Better Auth's schema — an all-empty composite must never blank it. (The action
  // requires a first name, so this is a guard, not a path onboarding takes.)
  it("preserves the existing name when the composite would be empty", async () => {
    const id = await seedUser(); // "Ada Lovelace"
    await completeOnboarding(auth, {
      userId: id,
      firstName: "   ",
      lastName: "",
      onboardedAt: new Date(),
    });
    expect((await readOnboardingState(auth, id))!.name).toBe("Ada Lovelace");
  });

  it("is idempotent — re-completing just re-stamps and does not error", async () => {
    const id = await seedUser();
    await completeOnboarding(auth, {
      userId: id,
      firstName: "A",
      lastName: "B",
      onboardedAt: new Date(),
    });
    const second = await completeOnboarding(auth, {
      userId: id,
      firstName: "A",
      lastName: "B",
      onboardedAt: new Date(),
    });
    expect(second).toBe(true);
  });

  it("returns false when completing a user that is gone", async () => {
    expect(
      await completeOnboarding(auth, {
        userId: `user_${randomUUID()}`,
        firstName: "X",
        lastName: "Y",
        onboardedAt: new Date(),
      }),
    ).toBe(false);
  });
});

describe("updateUserName", () => {
  async function seedUser(name: string): Promise<string> {
    const id = `user_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
      values (${id}, ${name}, ${`${id}@e.test`}, ${true}, now())`;
    return id;
  }

  it("updates the display name (read back via getAuthUserProfile)", async () => {
    const id = await seedUser("Old Name");
    expect(await updateUserName(auth, { userId: id, name: "New Name" })).toBe(true);
    expect((await getAuthUserProfile(auth, id))!.name).toBe("New Name");
  });

  it("trims surrounding whitespace before storing", async () => {
    const id = await seedUser("Old");
    await updateUserName(auth, { userId: id, name: "  Grace Hopper  " });
    expect((await getAuthUserProfile(auth, id))!.name).toBe("Grace Hopper");
  });

  it("does NOT touch onboardedAt (an edit must not re-stamp the onboarding gate)", async () => {
    const id = await seedUser("Ada");
    const at = new Date("2026-07-14T00:00:00.000Z");
    await completeOnboarding(auth, {
      userId: id,
      firstName: "Ada",
      lastName: "L",
      onboardedAt: at,
    });
    await updateUserName(auth, { userId: id, name: "Ada Lovelace" });
    expect((await readOnboardingState(auth, id))!.onboardedAt).toEqual(at); // unchanged
  });

  it("refuses to blank the NOT-NULL name — empty/whitespace is a no-op that returns false", async () => {
    const id = await seedUser("Keep Me");
    expect(await updateUserName(auth, { userId: id, name: "   " })).toBe(false);
    expect((await getAuthUserProfile(auth, id))!.name).toBe("Keep Me"); // untouched
  });

  it("returns false for a user that does not exist", async () => {
    expect(await updateUserName(auth, { userId: `user_${randomUUID()}`, name: "Nobody" })).toBe(
      false,
    );
  });
});
