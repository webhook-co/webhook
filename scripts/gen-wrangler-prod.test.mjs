import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// End-to-end test of the prod-overlay generator's OPTIONAL-billing logic (S4 activation). It spawns the real
// generator (top-level side effects — reads env, writes apps/<app>/wrangler.prod.jsonc) with controlled env
// and asserts: dark (no billing vars) strips the optional Hyperdrive/secret bindings + empties the vars;
// provisioned keeps them with the real ids + injects the secrets; the meter-audit Hyperdrive is
// billing-INDEPENDENT; and every generated config is valid JSONC in both modes.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEN = join(REPO, "scripts", "gen-wrangler-prod.mjs");
const APPS = ["engine", "api", "web", "mcp", "auth"];

// Dummy ids for every reqEnv() the generator needs (no real infra touched).
const BASE = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  SECRETS_STORE_ID: "store",
  HYPERDRIVE_TENANT_ID: "t",
  HYPERDRIVE_CACHED_ID: "c",
  HYPERDRIVE_ANCHOR_ID: "a",
  HYPERDRIVE_RECONCILER_ID: "r",
  HYPERDRIVE_METER_ID: "m",
  HYPERDRIVE_AUTHN_ID: "n",
  HYPERDRIVE_INGEST_ID: "i",
  KV_CONFIG_ID: "kc",
  KV_AUTHZ_ID: "ka",
  AUTH_OAUTH_KV_ID: "ok",
  AUTH_DEVICE_KV_ID: "dk",
  AUTH_RATELIMIT_KV_ID: "rk",
  HYPERDRIVE_AUTH_ID: "au",
  HYPERDRIVE_SWEEPER_ID: "sw",
  HYPERDRIVE_NOTIFIER_ID: "no",
};

const BILLING_KEYS = [
  "BILLING_MODE",
  "STRIPE_METER_EVENT_NAME",
  "STRIPE_PLANS",
  "HYPERDRIVE_BILLING_ID",
  "HYPERDRIVE_METER_AUDIT_ID",
  "FREE_EVENT_CAP",
];

/** Run the generator with BASE + `extra`. Inherits the ambient env (PATH etc.) but CLEARS any billing vars
 *  first, so a real BILLING_MODE in the shell can't leak in — the test controls them exactly. */
function gen(extra = {}) {
  const env = { ...process.env };
  for (const k of BILLING_KEYS) delete env[k];
  execFileSync("node", [GEN], { cwd: REPO, env: { ...env, ...BASE, ...extra }, stdio: "pipe" });
}

/** Read a generated wrangler.prod.jsonc and parse it as JSONC (strip full-line // comments + trailing commas). */
function readProd(app) {
  const raw = readFileSync(join(REPO, "apps", app, "wrangler.prod.jsonc"), "utf8");
  const json = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(json);
}
const hasHyperdrive = (cfg, binding) => (cfg.hyperdrive ?? []).some((h) => h.binding === binding);
const hasSecret = (cfg, name) =>
  (cfg.secrets_store_secrets ?? []).some((s) => s.secret_name === name);

test("DARK (no billing vars): optional bindings stripped, vars empty, valid JSONC", () => {
  gen();
  for (const app of APPS) readProd(app); // parses → valid JSONC in dark mode
  const api = readProd("api");
  assert.equal(hasHyperdrive(api, "HYPERDRIVE_BILLING"), false);
  assert.equal(hasSecret(api, "STRIPE_WEBHOOK_SIGNING_SECRET"), false);
  assert.equal(api.vars.BILLING_MODE, "");
  const engine = readProd("engine");
  assert.equal(hasHyperdrive(engine, "HYPERDRIVE_METER_AUDIT"), false);
  assert.equal(hasSecret(engine, "STRIPE_SECRET_KEY"), false);
  assert.equal(engine.vars.BILLING_MODE, "");
  const web = readProd("web");
  assert.equal(hasSecret(web, "STRIPE_SECRET_KEY"), false);
  assert.equal(web.vars.STRIPE_PLANS, "");
});

test("PROVISIONED (BILLING_MODE=test + ids): bindings kept with ids, secrets injected, valid JSONC", () => {
  gen({
    BILLING_MODE: "test",
    STRIPE_METER_EVENT_NAME: "webhook_events",
    STRIPE_PLANS: '{"pro":{"base":"price_b","overage":"price_o"}}',
    HYPERDRIVE_BILLING_ID: "hb",
    HYPERDRIVE_METER_AUDIT_ID: "hma",
  });
  for (const app of APPS) readProd(app); // parses → valid JSONC in provisioned mode
  const api = readProd("api");
  assert.equal(api.hyperdrive.find((h) => h.binding === "HYPERDRIVE_BILLING")?.id, "hb");
  assert.equal(hasSecret(api, "STRIPE_WEBHOOK_SIGNING_SECRET"), true);
  assert.equal(api.vars.BILLING_MODE, "test");
  const engine = readProd("engine");
  assert.equal(engine.hyperdrive.find((h) => h.binding === "HYPERDRIVE_METER_AUDIT")?.id, "hma");
  assert.equal(hasSecret(engine, "STRIPE_SECRET_KEY"), true);
  assert.equal(engine.vars.STRIPE_METER_EVENT_NAME, "webhook_events");
  const web = readProd("web");
  assert.equal(hasSecret(web, "STRIPE_SECRET_KEY"), true);
  assert.deepEqual(JSON.parse(web.vars.STRIPE_PLANS), {
    pro: { base: "price_b", overage: "price_o" },
  });
});

test("the meter-audit Hyperdrive is billing-INDEPENDENT (kept without BILLING_MODE; no Stripe secret)", () => {
  gen({ HYPERDRIVE_METER_AUDIT_ID: "hma" }); // provisioned id, but billing OFF
  const engine = readProd("engine");
  assert.equal(engine.hyperdrive.find((h) => h.binding === "HYPERDRIVE_METER_AUDIT")?.id, "hma");
  assert.equal(hasSecret(engine, "STRIPE_SECRET_KEY"), false); // billing off → no outbound Stripe secret
});

test("a provisioned HYPERDRIVE_BILLING id is bound even though the secret gate is separate", () => {
  gen({ HYPERDRIVE_BILLING_ID: "hb" }); // id set, billing off
  const api = readProd("api");
  assert.equal(api.hyperdrive.find((h) => h.binding === "HYPERDRIVE_BILLING")?.id, "hb");
  assert.equal(hasSecret(api, "STRIPE_WEBHOOK_SIGNING_SECRET"), false); // billing off → no signing secret
});

test.after(() => {
  // Clean up the generated (gitignored) artifacts so a local run leaves no residue.
  for (const app of APPS) rmSync(join(REPO, "apps", app, "wrangler.prod.jsonc"), { force: true });
});

test("STRIPE_PLANS is JSON-escaped into the web vars and round-trips to the same map", () => {
  // The var's VALUE is itself JSON, embedded inside a JSON string. Without escaping, its quotes terminate
  // the string early and the generated wrangler.prod.jsonc is unparseable — a deploy-time-only failure that
  // no unit test of parseStripePlans could catch. `readProd` parsing at all is half the assertion.
  const plans =
    '{"pro":{"base":"price_pb","overage":"price_po"},"team":{"base":"price_tb","overage":"price_to"}}';
  gen({ BILLING_MODE: "test", STRIPE_PLANS: plans });
  const cfg = readProd("web");
  assert.equal(cfg.vars.STRIPE_PLANS, plans);
  assert.deepEqual(JSON.parse(cfg.vars.STRIPE_PLANS), {
    pro: { base: "price_pb", overage: "price_po" },
    team: { base: "price_tb", overage: "price_to" },
  });
});

test("an unset STRIPE_PLANS leaves an empty var (dark: Checkout disabled, not a broken config)", () => {
  gen();
  assert.equal(readProd("web").vars.STRIPE_PLANS, "");
});
