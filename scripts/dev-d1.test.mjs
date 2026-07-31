import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

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

// --- The wiring, not just the logic ------------------------------------------------------------
// Discovery being correct is worth nothing if `pnpm dev` stops calling it. Deleting it from the dev
// script would restore an empty local D1 — the original bug — with every test above still green.

test("`pnpm dev` actually applies D1 migrations before starting anything", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.dev, /dev-d1/, "pnpm dev no longer applies D1 migrations");
  assert.ok(
    pkg.scripts.dev.indexOf("dev-d1") < pkg.scripts.dev.indexOf("turbo run dev"),
    "D1 must be migrated BEFORE the apps start, or the first query still hits an empty database",
  );
  assert.equal(
    pkg.scripts["dev:d1"],
    "node scripts/dev-d1.mjs",
    "the standalone entry point is gone",
  );
});

test("a failed apply is fail-CLOSED", () => {
  // Continuing past a failed migration is the original bug wearing a hat: dev starts, looks fine, and
  // dies at the first query with `no such table`.
  const src = readFileSync(new URL("./dev-d1.mjs", import.meta.url), "utf8");
  assert.match(src, /status !== 0/, "the apply's exit status is not checked");
  assert.match(src, /process\.exit\(1\)/, "a failed apply does not stop the run");
});
