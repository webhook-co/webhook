import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseDevDbConfig } from "./dev-db-config.mjs";
import { dbRoles } from "./remote-db-test-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const line = (url) => `      "localConnectionString": "${url}",`;
const BASE = "postgres://postgres:postgres@127.0.0.1:5432/webhook_dev";

test("derives host/port/database/superuser from the wrangler localConnectionStrings", () => {
  const cfg = parseDevDbConfig([line(BASE)]);

  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.database, "webhook_dev");
  assert.equal(cfg.superuser, "postgres");
  assert.equal(cfg.password, "postgres");
});

test("collects every non-superuser role across all configs, deduped and sorted", () => {
  const cfg = parseDevDbConfig([
    line(BASE),
    line("postgres://webhook_billing:postgres@127.0.0.1:5432/webhook_dev"),
    line("postgres://webhook_app:postgres@127.0.0.1:5432/webhook_dev"),
    // a duplicate binding for the same role must not double-count
    line("postgres://webhook_billing:postgres@127.0.0.1:5432/webhook_dev"),
  ]);

  assert.deepEqual(cfg.roles, ["webhook_app", "webhook_billing"]);
});

test("the superuser is never listed as an app role to be created", () => {
  const cfg = parseDevDbConfig([line(BASE), line(BASE)]);

  assert.deepEqual(cfg.roles, []);
});

test("ignores non-localhost connection strings (a real Hyperdrive/Neon URL is not a dev target)", () => {
  const cfg = parseDevDbConfig([
    line(BASE),
    line("postgres://webhook_owner:hunter2@ep-prod.neon.tech:5432/webhook_prod"),
  ]);

  assert.deepEqual(cfg.roles, []);
  assert.equal(cfg.database, "webhook_dev");
});

test("throws when the local bindings disagree on the database — silent drift would half-provision", () => {
  assert.throws(
    () =>
      parseDevDbConfig([
        line(BASE),
        line("postgres://webhook_app:postgres@127.0.0.1:5432/other_db"),
      ]),
    /disagree/i,
  );
});

test("throws when the local bindings disagree on the port", () => {
  assert.throws(
    () =>
      parseDevDbConfig([
        line(BASE),
        line("postgres://webhook_app:postgres@127.0.0.1:5433/webhook_dev"),
      ]),
    /disagree/i,
  );
});

test("throws when no local connection string is found at all", () => {
  assert.throws(() => parseDevDbConfig(['      "binding": "HYPERDRIVE_TENANT",']), /no local/i);
});

// ── The real configs, not synthetic strings ───────────────────────────────────────────────────
// Every test above feeds the parser a hand-written string, so none of them can notice that the REAL
// bindings ask for a role no migration creates. That is not hypothetical: `webhook_activation_reviewer`
// was provisioned by hand in production and existed in no migration for the whole life of #708 —
// `pnpm dev:db` failed its required-login-role check, the production read path was pinned by no test,
// and nothing in CI noticed because `dev:db` runs in no workflow (#721).
//
// This closes the loop statically, no database required:
//   wrangler bindings ──(here)──▶ DB_ROLES ──(packages/db/test/migrations.test.ts)──▶ roles the migrations create
// The second arrow is already asserted both ways over a real engine (appRoles + discoveredAppRoles), so
// pinning the first arrow means a binding can never again name a role the schema will not have.

test("every role the REAL wrangler bindings connect as is declared in DB_ROLES", () => {
  const appsDir = join(ROOT, "apps");
  const texts = readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      try {
        return [readFileSync(join(appsDir, e.name, "wrangler.jsonc"), "utf8")];
      } catch {
        return []; // not every app is a Worker
      }
    });
  // Vacuity: if the configs stopped being found, every assertion below would pass trivially.
  assert.ok(texts.length >= 2, `expected the apps' wrangler configs, got ${texts.length}`);

  const cfg = parseDevDbConfig(texts);
  assert.ok(cfg.roles.length > 5, `expected the real binding roles, got ${cfg.roles.length}`);

  const declared = dbRoles(readFileSync(join(ROOT, "packages/db/src/constants.ts"), "utf8"));
  assert.ok(declared && declared.size > 10, "could not parse DB_ROLES");
  const known = new Set(declared.values());

  const undeclared = cfg.roles.filter((r) => !known.has(r));
  assert.deepEqual(
    undeclared,
    [],
    `wrangler bindings connect as role(s) absent from DB_ROLES — so no migration creates them, ` +
      `\`pnpm dev:db\` fails its login-role check, and \`wrangler dev\` dies inside a Worker on an ` +
      `opaque auth error: ${undeclared.join(", ")}`,
  );
});

test("the reviewer role specifically is wired end to end (the #721 regression)", () => {
  const declared = dbRoles(readFileSync(join(ROOT, "packages/db/src/constants.ts"), "utf8"));
  assert.ok(
    [...declared.values()].includes("webhook_activation_reviewer"),
    "webhook_activation_reviewer must stay in DB_ROLES — apps/api's reviewer Hyperdrive connects as it",
  );
});
