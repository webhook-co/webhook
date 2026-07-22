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
const APPS = ["engine", "api", "web", "mcp", "auth", "health"];

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
  KV_HEALTH_ID: "kh",
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
  "STRIPE_PORTAL_CONFIGURATION_ID",
  "STRIPE_METER_ID",
  "HYPERDRIVE_METER_TRANSPORT_AUDIT_ID",
  "HYPERDRIVE_BILLING_ID",
  "HYPERDRIVE_METER_AUDIT_ID",
  "FREE_EVENT_CAP",
  // data-lifecycle optional cross-org Hyperdrives — cleared so an ambient shell var can't make the DARK
  // assertions flap.
  "HYPERDRIVE_PURGE_ID",
  "HYPERDRIVE_RETENTION_ID",
  "HYPERDRIVE_ACTIVATION_REVIEWER_ID",
  // apps/health's heartbeat-secret gate — cleared for the same reason: an ambient var must not make
  // the dark assertions flap.
  "HEARTBEAT_TOKEN_READY",
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
  assert.equal(hasSecret(api, "STRIPE_SECRET_KEY"), false); // WS3: tail-flush key dark when billing off
  assert.equal(hasHyperdrive(api, "HYPERDRIVE_ACTIVATION_REVIEWER"), false); // ADR-0127: reviewer dark by default
  assert.equal(hasSecret(api, "INTERNAL_REVIEW_TOKEN"), false); // ADR-0127: bearer secret dark by default
  assert.equal(api.vars.BILLING_MODE, "");
  assert.equal(api.vars.STRIPE_METER_EVENT_NAME, ""); // WS3: flush meter name empty → dark
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
  assert.equal(hasSecret(api, "STRIPE_SECRET_KEY"), true); // WS3: tail-flush key bound when billing on
  assert.equal(api.vars.BILLING_MODE, "test");
  assert.equal(api.vars.STRIPE_METER_EVENT_NAME, "webhook_events"); // WS3: flush meter name injected
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

test("the activation-reviewer endpoint bindings are billing-INDEPENDENT (Hyperdrive + bearer secret injected, no BILLING_MODE)", () => {
  gen({ HYPERDRIVE_ACTIVATION_REVIEWER_ID: "har" }); // provisioned id, billing OFF
  const api = readProd("api");
  assert.equal(
    api.hyperdrive.find((h) => h.binding === "HYPERDRIVE_ACTIVATION_REVIEWER")?.id,
    "har",
  );
  assert.equal(hasSecret(api, "INTERNAL_REVIEW_TOKEN"), true); // bearer secret injected alongside the Hyperdrive
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

// Every env var the generator READS must be forwarded by the workflow that RUNS it. This exists because
// #426 renamed STRIPE_PRICE_BASE/OVERAGE -> STRIPE_PLANS in the generator and the committed wrangler, but
// deploy-web.yml kept forwarding the dead names. The generator then saw "" and fail-closed the dashboard's
// plan picker into `hidden` — a silent prod defect that typecheck, unit tests, and this file's other tests
// all missed, because they set the env directly and never read the workflow.
test("every billing env var the generator reads is forwarded by its deploy workflow", () => {
  const gen = readFileSync(GEN, "utf8");
  // The generator reads billing config as `process.env.NAME`.
  const read = new Set(
    [...gen.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
      .map((m) => m[1])
      .filter((n) =>
        /^(BILLING_MODE|STRIPE_|FREE_EVENT_CAP|HYPERDRIVE_(BILLING|METER_AUDIT)_ID)/.test(n),
      ),
  );
  assert.ok(read.size > 0, "expected the generator to read some billing env vars");

  const workflows = ["deploy.yml", "deploy-web.yml", "deploy-auth.yml"].map((f) =>
    readFileSync(join(REPO, ".github", "workflows", f), "utf8"),
  );
  const forwardedAnywhere = new Set(
    workflows.flatMap((w) =>
      [...w.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):\s*\$\{\{\s*vars\./gm)].map((m) => m[1]),
    ),
  );

  const missing = [...read].filter((n) => !forwardedAnywhere.has(n));
  assert.deepEqual(
    missing,
    [],
    `generator reads these but no deploy workflow forwards them: ${missing}`,
  );

  // And the reverse: a workflow must not forward a billing var the generator no longer reads (a dead name
  // is how the STRIPE_PLANS regression hid — the workflow looked configured).
  const forwardedBilling = [...forwardedAnywhere].filter((n) =>
    /^(BILLING_MODE|STRIPE_|FREE_EVENT_CAP)/.test(n),
  );
  const dead = forwardedBilling.filter((n) => !read.has(n));
  assert.deepEqual(
    dead,
    [],
    `deploy workflows forward these, but the generator ignores them: ${dead}`,
  );
});

test("STRIPE_METER_ID + the transport Hyperdrive: bound when provisioned, stripped when dark", () => {
  // Provisioned: the meter id lands as an engine var and the transport Hyperdrive binding is present.
  gen({
    BILLING_MODE: "live",
    STRIPE_METER_ID: "mtr_live_x",
    HYPERDRIVE_METER_TRANSPORT_AUDIT_ID: "hd_transport_x",
  });
  const eng = readProd("engine");
  assert.equal(eng.vars.STRIPE_METER_ID, "mtr_live_x");
  assert.ok(
    (eng.hyperdrive ?? []).some((h) => h.binding === "HYPERDRIVE_METER_TRANSPORT_AUDIT"),
    "transport Hyperdrive should be bound when its id is set",
  );

  // Dark: unset id → the whole @gen-optional block is stripped, and the var is empty.
  gen();
  const dark = readProd("engine");
  assert.equal(dark.vars.STRIPE_METER_ID, "");
  assert.ok(
    !(dark.hyperdrive ?? []).some((h) => h.binding === "HYPERDRIVE_METER_TRANSPORT_AUDIT"),
    "transport Hyperdrive should be stripped when its id is unset",
  );
});

test("HYPERDRIVE_RETENTION (slice 2.3): bound when provisioned, stripped when dark (billing-independent)", () => {
  // Provisioned: the retention prune's cross-org Hyperdrive binding is present. It is NOT gated on billing —
  // the prune runs (Free window) as soon as the role + Hyperdrive exist.
  gen({ HYPERDRIVE_RETENTION_ID: "hd_retention_x" });
  const eng = readProd("engine");
  assert.equal(
    (eng.hyperdrive ?? []).find((h) => h.binding === "HYPERDRIVE_RETENTION")?.id,
    "hd_retention_x",
    "retention Hyperdrive should be bound when its id is set",
  );

  // Dark: unset id → the whole @gen-optional block is stripped and the prune cron skips.
  gen();
  const dark = readProd("engine");
  assert.ok(
    !(dark.hyperdrive ?? []).some((h) => h.binding === "HYPERDRIVE_RETENTION"),
    "retention Hyperdrive should be stripped when its id is unset",
  );
});

// --- apps/health: the HEARTBEAT_TOKEN_READY gate -------------------------------------------------
//
// `wrangler deploy` FAILS outright when it binds a secret that does not exist in the store, so this
// gate is what lets the Worker ship before the credential is minted. Both directions are asserted:
// an ungated binding would block the deploy, and a permanently-gated one would leave heartbeat
// reporting silently dead.

test("health DARK (no HEARTBEAT_TOKEN_READY): no secret bound, KV id substituted, no tenant secrets", () => {
  gen();
  const cfg = readProd("health");
  assert.deepEqual(cfg.secrets_store_secrets, []);
  assert.equal(cfg.kv_namespaces[0].binding, "HEALTH_KV");
  assert.equal(cfg.kv_namespaces[0].id, "kh");
  assert.equal(cfg.routes[0].pattern, "health.wbhk.my");
  // It touches no tenant data, payloads or credentials beyond its own bearer tokens — binding the
  // shared keys here would widen its blast radius for nothing.
  const raw = JSON.stringify(cfg);
  for (const shared of ["CREDENTIAL_PEPPER", "CURSOR_KEY", "AUDIT_CHAIN_HMAC_KEY"]) {
    assert.ok(!raw.includes(shared), `health must not bind ${shared}`);
  }
});

test("health READY (HEARTBEAT_TOKEN_READY set): the heartbeat secret is bound", () => {
  gen({ HEARTBEAT_TOKEN_READY: "1" });
  const names = readProd("health").secrets_store_secrets.map((s) => s.secret_name);
  assert.deepEqual(names, ["HEARTBEAT_TOKEN"]);
});

test("engine and auth carry the heartbeat credential only when the gate is set", () => {
  // The receiver having the credential is useless if the REPORTERS do not: every job would report
  // into a 404, which on the status page is indistinguishable from a real outage.
  gen();
  for (const app of ["engine", "auth"]) {
    assert.equal(hasSecret(readProd(app), "HEARTBEAT_TOKEN"), false, `${app} dark`);
  }
  gen({ HEARTBEAT_TOKEN_READY: "1" });
  for (const app of ["engine", "auth", "health"]) {
    assert.equal(hasSecret(readProd(app), "HEARTBEAT_TOKEN"), true, `${app} ready`);
  }
});

test("engine and auth know where to report, and it is not a secret", () => {
  gen();
  for (const app of ["engine", "auth"]) {
    assert.equal(readProd(app).vars.HEALTH_HEARTBEAT_URL, "https://health.wbhk.my");
  }
});
