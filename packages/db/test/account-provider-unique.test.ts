import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Migration 0076 adds a UNIQUE index on account ("providerId","accountId") — the stable external OAuth
// identity pair. These tests prove the index makes a duplicate identity unrepresentable (the race two
// concurrent social-sign-in callbacks could otherwise win) while still allowing genuinely distinct pairs.
// account is the RLS-exempt identity table; seed it as webhook_owner, the role that owns it.

let pg: EphemeralPostgres;
let owner: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, setupHookTimeoutMs());

afterAll(async () => {
  // A real-PG test MUST stop its ephemeral cluster — a leaked DB pins cluster-global roles on CI's shared
  // cluster and breaks the migrations down-all DROP ROLE.
  await owner?.end();
  await pg?.stop();
});

async function seedUser(): Promise<string> {
  const id = `user_${randomUUID()}`;
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${"Ident User"}, ${`${id}@e.test`}, ${true}, now())`;
  return id;
}

async function insertAccount(userId: string, providerId: string, accountId: string): Promise<void> {
  await owner`
    insert into "account" ("id", "accountId", "providerId", "userId", "updatedAt")
    values (${`acct_${randomUUID()}`}, ${accountId}, ${providerId}, ${userId}, now())`;
}

describe("account (providerId, accountId) unique index — migration 0076", () => {
  it("rejects a second account row with the same (providerId, accountId), even under a different user", async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    await insertAccount(u1, "github", "12345");
    // An OAuth identity maps to exactly one account row; a duplicate pair — even attributed to a different
    // user — is the nondeterministic state the index forbids. 23505 = unique_violation.
    await expect(insertAccount(u2, "github", "12345")).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same accountId under a different provider, and the same provider with a different accountId", async () => {
    const u = await seedUser();
    await insertAccount(u, "github", "777");
    // Uniqueness is on the PAIR: a different provider (or a different account id) is a genuinely distinct
    // identity and must still be insertable.
    await expect(insertAccount(u, "google", "777")).resolves.toBeUndefined();
    await expect(insertAccount(u, "github", "888")).resolves.toBeUndefined();
  });
});
