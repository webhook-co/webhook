import assert from "node:assert/strict";
import { test } from "node:test";

import { d1Apps, discoverD1 } from "./dev-d1.mjs";

// `pnpm dev` started apps/dmarc against a D1 database with NO SCHEMA: `d1 migrations apply` existed only
// in .github/workflows/deploy-dmarc.yml, so production had the tables and no local machine ever did. The
// symptom was `pnpm cron dmarc` → `D1_ERROR: no such table: alert_state`, i.e. a capability that ships in
// prod and could not be exercised here at all.

test("discovery reads the binding and migrations dir out of a wrangler config", () => {
  const cfg = `{
    "name": "webhook-dmarc",
    "d1_databases": [
      { "binding": "DMARC_DB", "database_name": "webhook-dmarc", "migrations_dir": "migrations" }
    ]
  }`;
  assert.deepEqual(discoverD1(cfg), [
    { databaseName: "webhook-dmarc", migrationsDir: "migrations" },
  ]);
});

test("an app with no D1 yields nothing", () => {
  assert.deepEqual(discoverD1('{ "name": "webhook-api", "main": "src/index.ts" }'), []);
});

test("a D1 database with no migrations_dir is skipped, not guessed", () => {
  // Applying migrations from an assumed directory would either fail confusingly or apply the wrong ones.
  const cfg = '{ "d1_databases": [{ "binding": "X", "database_name": "d" }] }';
  assert.deepEqual(discoverD1(cfg), []);
});

test("the real repo has at least one D1 app, so this is not vacuous", () => {
  const apps = d1Apps();
  assert.ok(apps.length >= 1, "no D1 app discovered — has discovery broken?");
  assert.ok(
    apps.some((a) => a.app === "dmarc" && a.databaseName === "webhook-dmarc"),
    "dmarc's D1 database was not discovered",
  );
});
