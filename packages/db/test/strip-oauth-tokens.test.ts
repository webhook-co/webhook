import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Migration 0061 — the ONE-SHOT backfill that nulls the unused provider OAuth tokens (accessToken /
// refreshToken / idToken) on pre-existing `account` rows (data minimization; the ongoing guarantee is the
// auth runtime's account databaseHook). This drives the REAL migration SQL read from the file (not a copy)
// against a row seeded WITH tokens, and asserts the tokens are gone while the identity-linking columns
// survive — a wrong WHERE/SET here would either miss tokens or clobber the account link.

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
  "0061_strip_oauth_tokens.sql",
);

/** The executable `-- migrate:up` body of the migration file (everything before `-- migrate:down`). */
function migrationUpSql(): string {
  const text = readFileSync(MIGRATION, "utf8");
  const up = text.split("-- migrate:down")[0]!.replace("-- migrate:up", "");
  return up.trim();
}

let pg: EphemeralPostgres;
let owner: Sql; // seeds + reads the global identity tables (user/account)

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await owner?.end();
  await pg?.stop();
});

describe("migration 0061 — strip unused OAuth tokens", () => {
  it("nulls accessToken/refreshToken/idToken on an existing row, preserving the identity link", async () => {
    const userId = `user_${randomUUID()}`;
    const accountId = `acct_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
      values (${userId}, ${"Dana"}, ${`${userId}@e.test`}, ${true}, now())`;
    await owner`
      insert into "account"
        ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "scope",
         "updatedAt")
      values (${accountId}, ${"google-sub-9"}, ${"google"}, ${userId}, ${"ya29.SECRET"},
              ${"1//SECRET"}, ${"eyJ.SECRET.jwt"}, ${"openid email"}, now())`;

    // Run the actual shipped migration statement.
    await owner.unsafe(migrationUpSql());

    const [row] = await owner`
      select "accessToken", "refreshToken", "idToken", "accountId", "providerId", "userId", "scope"
      from "account" where "id" = ${accountId}`;
    expect(row!.accessToken).toBeNull();
    expect(row!.refreshToken).toBeNull();
    expect(row!.idToken).toBeNull();
    // Identity linkage + scope untouched — the account still resolves the same provider identity.
    expect(row!.accountId).toBe("google-sub-9");
    expect(row!.providerId).toBe("google");
    expect(row!.userId).toBe(userId);
    expect(row!.scope).toBe("openid email");
  });

  it("is idempotent — a second run over already-null tokens is a no-op (no error, still null)", async () => {
    const userId = `user_${randomUUID()}`;
    const accountId = `acct_${randomUUID()}`;
    await owner`
      insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
      values (${userId}, ${"Rio"}, ${`${userId}@e.test`}, ${true}, now())`;
    // A magic-link (no social) account carries no tokens to begin with — must survive untouched.
    await owner`
      insert into "account" ("id", "accountId", "providerId", "userId", "updatedAt")
      values (${accountId}, ${userId}, ${"credential"}, ${userId}, now())`;

    await owner.unsafe(migrationUpSql());
    await owner.unsafe(migrationUpSql());

    const [row] = await owner`
      select "accessToken", "refreshToken", "idToken", "providerId" from "account"
      where "id" = ${accountId}`;
    expect(row!.accessToken).toBeNull();
    expect(row!.refreshToken).toBeNull();
    expect(row!.idToken).toBeNull();
    expect(row!.providerId).toBe("credential");
  });
});
