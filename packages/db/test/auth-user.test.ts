import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { getAuthUserProfile } from "../src/auth-user";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Lane C A-SX-2a — getAuthUserProfile reads a better-auth user's display fields (name/email/image) for the
// session-exchange redeem. The `user` table is the GLOBAL identity realm (no tenant RLS); webhook_auth has
// DML on it (migration 0016). Read FRESH at redeem — never denormalized into the exchange ticket.

let pg: EphemeralPostgres;
let auth: Sql; // webhook_auth — the identity role
let owner: Sql; // seeds the better-auth "user" rows

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  auth = createClient(pg.urlFor({ role: DB_ROLES.auth }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, 90_000);

afterAll(async () => {
  await auth?.end();
  await owner?.end();
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
