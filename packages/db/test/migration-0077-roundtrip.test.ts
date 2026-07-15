import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { migrateDown, migrateUp, setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Migration 0077 (user.email text -> citext) must be REVERSIBLE with its EFFECT intact, not just structurally.
// migrations.test.ts proves `down` runs without error; this proves the down actually RESTORES case-sensitive
// uniqueness (so a rollback can't silently leave email uniqueness in the wrong state), and that up re-applies
// the case-insensitive guarantee. Own file + own ephemeral cluster so the down/up churn can't disturb the
// forward-only citext tests.

let pg: EphemeralPostgres;
let owner: Sql;
let admin: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await pg?.stop();
});

/** True while "user".email is citext (0077 applied); false once it's back to text. */
async function emailIsCitext(): Promise<boolean> {
  const [row] = await admin<{ udt: string }[]>`
    select udt_name as udt from information_schema.columns
    where table_name = 'user' and column_name = 'email'`;
  return row!.udt === "citext";
}

async function insertUser(email: string): Promise<void> {
  const id = `user_${randomUUID()}`;
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${"Roundtrip"}, ${email}, ${true}, now())`;
}

describe("migration 0077 reversibility (effect, not just structure)", () => {
  it("down restores case-SENSITIVE uniqueness; up re-applies the case-insensitive guarantee", async () => {
    // Peel migrations until 0077's own down has run (email back to text). Data-driven + bounded so a later
    // migration landing above 0077 never breaks this, and a broken down can't loop forever.
    for (let i = 0; i < 50 && (await emailIsCitext()); i++) migrateDown(pg);
    expect(await emailIsCitext()).toBe(false); // we actually reached 0077's down

    // Case-sensitive again: two case-variants are now DISTINCT rows and both insert.
    await insertUser("Ada@Example.com");
    await expect(insertUser("ada@example.com")).resolves.toBeUndefined();

    // Re-apply everything. The pre-existing case-variant rows above would make the citext UNIQUE build fail,
    // so clear them first — this test is about the schema invariant, not the data.
    await owner`delete from "user" where lower("email") = ${"ada@example.com"}`;
    migrateUp(pg);
    expect(await emailIsCitext()).toBe(true);

    // Case-insensitive guarantee is back: the variant is rejected.
    await insertUser("Bob@Example.com");
    await expect(insertUser("bob@example.com")).rejects.toMatchObject({ code: "23505" });
  });
});
