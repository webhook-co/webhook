import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { migrateDown, migrateUp, setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

/** True once the `delivery_attempts.billable` column (added by 0055) exists. */
async function billableColumnExists(admin: Sql): Promise<boolean> {
  const [row] = await admin<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'delivery_attempts' and column_name = 'billable'
    ) as exists`;
  return row!.exists;
}

// Migration 0055 (billable dispatches) must be REVERSIBLE without collateral damage. Both reviewers
// flagged the same trap: `revoke select (...) on delivery_attempts` is not grant-counted, so naming a
// column 0049 also granted would strip it on rollback and leave the F6 reconciler with no read on
// delivery_attempts — the drift oracle guarding live money, dark, at a supposedly known-good 0049 state.
// This proves down-then-reconcile keeps webhook_meter_audit's 0049 grant intact, and that up→down→up works.

let pg: EphemeralPostgres;
let audit: Sql;
let admin: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  audit = createClient(pg.urlFor({ role: DB_ROLES.meterAudit }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await audit?.end();
  await admin?.end();
  await pg?.stop();
});

describe("migration 0055 reversibility", () => {
  it("rolls back to 0049 without stripping webhook_meter_audit's delivery_attempts read", async () => {
    // Step down until 0055's `billable` column is gone — i.e. run 0055's OWN down, peeling whatever later
    // migrations sit on top of it first. Data-driven (not a hardcoded count) so a new migration landing above
    // 0055 never breaks this test. Bounded so a broken down-migration can't loop forever.
    for (let i = 0; i < 50 && (await billableColumnExists(admin)); i++) migrateDown(pg);
    expect(await billableColumnExists(admin)).toBe(false); // we actually reached 0055's down

    // The 0049-era grant (org_id, created_at) must survive — the reconciler reads exactly these as this role.
    await expect(
      audit`select org_id, created_at from delivery_attempts limit 0`,
    ).resolves.toBeDefined();

    // …and `billable` is gone (the column was dropped), so a read of it fails.
    await expect(audit`select billable from delivery_attempts limit 0`).rejects.toThrow();

    // Re-apply everything: the schema is whole again and `billable` is back.
    migrateUp(pg);
    await expect(audit`select billable from delivery_attempts limit 0`).resolves.toBeDefined();
  });
});
