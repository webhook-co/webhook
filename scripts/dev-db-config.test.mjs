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

// --- identifier validation -------------------------------------------------------------------
//
// `database` and every role name flow straight into a shell assignment and into SQL in
// scripts/dev-db.sh (`rolname='$role'`, `createdb "$DB"`, the dbmate DATABASE_URL). They are derived
// from url.pathname / url.username of a connection string in a checked-out wrangler.jsonc, and WHATWG
// percent-encoding leaves `;`, `$`, `(`, `)`, `|`, `'` and `"` intact — so an unvalidated value is a
// live shell- and SQL-injection primitive. Reject anything that is not a plain Postgres identifier at
// the parser, which is the one place every consumer goes through.

const withDb = (db) => line(`postgres://postgres:postgres@127.0.0.1:5432/${db}`);
const withUser = (user) => `postgres://${user}:postgres@127.0.0.1:5432/webhook_dev`;

test("accepts ordinary Postgres identifiers", () => {
  assert.equal(parseDevDbConfig([withDb("webhook_dev")]).database, "webhook_dev");
  assert.equal(parseDevDbConfig([withDb("Db_9")]).database, "Db_9");
  assert.deepEqual(parseDevDbConfig([line(BASE), line(withUser("webhook_app"))]).roles, [
    "webhook_app",
  ]);
});

test("rejects a database name carrying shell metacharacters", () => {
  for (const bad of [
    "webhook_dev;id",
    "webhook_dev$(id)",
    "webhook_dev`id`",
    "webhook_dev|id",
    "webhook_dev&id",
    "webhook_dev'",
    "webhook dev",
    "webhook-dev",
    "",
  ]) {
    assert.throws(
      () => parseDevDbConfig([withDb(bad)]),
      /database/i,
      `expected a throw for database ${JSON.stringify(bad)}`,
    );
  }
});

test("rejects a role name carrying shell or SQL metacharacters", () => {
  // dev-db.sh interpolates each role into `rolname='$role'` — an unescaped quote closes the literal.
  for (const bad of ["webhook_app'--", "webhook_app;drop", "webhook_app$(id)", "webhook app"]) {
    assert.throws(
      () => parseDevDbConfig([line(BASE), line(withUser(encodeURIComponent(bad)))]),
      /role/i,
      `expected a throw for role ${JSON.stringify(bad)}`,
    );
  }
});

test("a leading digit is not a valid identifier", () => {
  assert.throws(() => parseDevDbConfig([withDb("9lives")]), /database/i);
});

test("the real repo configs still parse — validation must not reject production truth", () => {
  // Anti-vacuity: if the pattern were too strict, every test above would still pass while the actual
  // bootstrap broke. Parse what is really committed.
  const texts = readdirSync(join(ROOT, "apps")).map((d) => {
    try {
      return readFileSync(join(ROOT, "apps", d, "wrangler.jsonc"), "utf8");
    } catch {
      return "";
    }
  });
  const cfg = parseDevDbConfig(texts);
  assert.equal(cfg.database, "webhook_dev");
  assert.ok(cfg.roles.length >= 10, `expected the real role set, got ${cfg.roles.length}`);
});

test("a double quote cannot reach the parsed value at all — CONN_RE terminates on it", () => {
  // Not a validation case: `"localConnectionString"\s*:\s*"([^"]+)"` stops at the first `"`, so the
  // quote is never part of the captured URL. Asserting this keeps someone from later "fixing" the
  // identifier check to cover a character that structurally cannot arrive.
  const cfg = parseDevDbConfig([line(`postgres://postgres:postgres@127.0.0.1:5432/webhook_dev"`)]);
  assert.equal(cfg.database, "webhook_dev");
});
