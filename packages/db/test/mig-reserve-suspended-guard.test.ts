import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Sql } from "../src/client";
import { DB_ROLES, TENANT_GUC } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

let pg: EphemeralPostgres;
let owner: Sql;
let app: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }), { max: 2 });
  app = createClient(pg.urlFor({ role: DB_ROLES.app }), { max: 2 });
}, setupHookTimeoutMs());

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => {});
  await app?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop();
});

// The migration's self-check must actually RAISE — not silently pass. `orgs` is FORCE RLS, so a bare
// `select from orgs` inside the migration sees zero rows and the guard would be a no-op (this test is how
// that no-op was caught: the guard needed `disable row level security` to see the squatting org at all).
// Simulate a prod where 'suspended' is already taken: roll the reserved list back (down-body), insert the
// org, then re-apply the up-body and assert it refuses.
describe("migration: reserve suspended slug — self-guard", () => {
  it("RAISES when an org already holds the suspended slug (guard is not a FORCE-RLS no-op)", async () => {
    const sql = readFileSync(
      join(__dirname, "..", "db", "migrations", "0096_reserve_suspended_slug.sql"),
      "utf8",
    );
    const down = sql.split("-- migrate:down")[1]!;
    const up = sql.split("-- migrate:up")[1]!.split("-- migrate:down")[0]!;

    // Roll the reserved list BACK so 'suspended' is insertable, then seed an org that holds it.
    await owner.unsafe(down);
    const id = randomUUID();
    await app.begin(async (tx) => {
      await tx`select set_config(${TENANT_GUC}, ${id}, true)`;
      await tx`insert into orgs (id, slug, name, region, retention_days)
               values (${id}, ${"suspended"}::citext, ${"Squatter"}, ${"us"}, ${7})`;
    });

    // Now the up-migration's guard must refuse.
    await expect(owner.unsafe(up)).rejects.toThrow(/already holds it/i);
  });
});
