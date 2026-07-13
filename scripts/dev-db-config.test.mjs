import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDevDbConfig } from "./dev-db-config.mjs";

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
