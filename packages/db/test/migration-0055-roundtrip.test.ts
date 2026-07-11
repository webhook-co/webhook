import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { migrateDownThrough, migrateUp, setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Migration 0055 (billable dispatches) must be REVERSIBLE without collateral damage. Both reviewers
// flagged the same trap: `revoke select (...) on delivery_attempts` is not grant-counted, so naming a
// column 0049 also granted would strip it on rollback and leave the F6 reconciler with no read on
// delivery_attempts — the drift oracle guarding live money, dark, at a supposedly known-good 0049 state.
// This proves down-then-reconcile keeps webhook_meter_audit's 0049 grant intact, and that up→down→up works.

let pg: EphemeralPostgres;
let audit: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  audit = createClient(pg.urlFor({ role: DB_ROLES.meterAudit }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await audit?.end();
  await pg?.stop();
});

describe("migration 0055 reversibility", () => {
  it("rolls back to 0049 without stripping webhook_meter_audit's delivery_attempts read", async () => {
    // Down THROUGH 0055 (i.e. undo 0055 and anything newer), leaving 0049 applied. Naming the version
    // rather than stepping once keeps this test about 0055 no matter how many migrations land after it.
    migrateDownThrough(pg, "0055");

    // The 0049-era grant (org_id, created_at) must survive — the reconciler reads exactly these as this role.
    await expect(
      audit`select org_id, created_at from delivery_attempts limit 0`,
    ).resolves.toBeDefined();

    // …and `billable` is gone (the column was dropped), so a read of it fails.
    await expect(audit`select billable from delivery_attempts limit 0`).rejects.toThrow();

    // Re-apply: the schema is whole again and `billable` is back.
    migrateUp(pg);
    await expect(audit`select billable from delivery_attempts limit 0`).resolves.toBeDefined();
  });
});
