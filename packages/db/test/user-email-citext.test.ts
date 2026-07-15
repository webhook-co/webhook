import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Migration 0077 converts "user".email to citext, making email identity case-insensitive-unique at the DB
// (not just in Better Auth's app-layer lowercasing). These tests prove a case-variant twin is now rejected
// while genuinely-distinct emails still insert. "user" is the RLS-exempt identity table; seed as the owner.

let pg: EphemeralPostgres;
let owner: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, setupHookTimeoutMs());

afterAll(async () => {
  // Stop the ephemeral cluster — a leaked DB pins cluster-global roles on CI's shared cluster.
  await owner?.end();
  await pg?.stop();
});

async function insertUser(email: string): Promise<void> {
  const id = `user_${randomUUID()}`;
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${"Case User"}, ${email}, ${true}, now())`;
}

describe("user.email citext case-insensitive uniqueness — migration 0077", () => {
  it("rejects a case-variant of an existing email (the duplicate identity citext forbids)", async () => {
    await insertUser("Ada@Example.com");
    // Same address, different case — one identity. Pre-0077 (text) this inserted a second row; now it's a
    // unique_violation (23505) because citext equality is case-insensitive.
    await expect(insertUser("ada@example.com")).rejects.toMatchObject({ code: "23505" });
    await expect(insertUser("ADA@EXAMPLE.COM")).rejects.toMatchObject({ code: "23505" });
  });

  it("still accepts genuinely distinct emails", async () => {
    await insertUser("bob@example.com");
    await expect(insertUser("carol@example.com")).resolves.toBeUndefined();
    await expect(insertUser("bob@other.com")).resolves.toBeUndefined(); // different domain, distinct identity
  });

  it("preserves the stored casing (citext compares case-insensitively but stores as written)", async () => {
    await insertUser("Dana.Mixed@Example.com");
    const [row] = await owner<{ email: string }[]>`
      select "email"::text as email from "user" where "email" = ${"dana.mixed@example.com"}`;
    // Lookup matched case-insensitively, but the original casing is retained (citext preserves input).
    expect(row?.email).toBe("Dana.Mixed@Example.com");
  });
});
