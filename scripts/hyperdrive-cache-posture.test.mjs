// Tests for scripts/hyperdrive-cache-posture.mjs — the two-layer guard keeping tenant-scoped reads off a
// CACHING Hyperdrive pool. Drives the REAL exported decisions (exactly what main()/the lint guard call) plus
// live assertions over the actual shipped apps/*/wrangler.jsonc, so a real regression is a red build rather
// than a fixture that agrees with itself.
//
// Layer 1 (bindingPlaceholderViolations) is network-free and runs in `lint`: it pins each hyperdrive binding
// to ITS OWN id placeholder, so a tenant binding can never be re-pointed at the cached pool.
// Layer 2 (cachePostureViolations) runs at deploy: it resolves the GENERATED overlay's real ids against the
// Cloudflare API and proves the pool each binding actually resolves to has caching disabled.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CACHING_ALLOWED_BINDINGS,
  DB_APPS,
  REQUIRED_TENANT_BINDING,
  bindingPlaceholderViolations,
  cachePostureViolations,
  configsByIdFromPages,
  fetchAllConfigs,
  hyperdriveBindings,
  missingDbApps,
} from "./hyperdrive-cache-posture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const off = (name) => ({ name, caching: { disabled: true } });
const on = (name) => ({ name, caching: { disabled: false } });

// ---------------------------------------------------------------- hyperdriveBindings (text extraction)

test("hyperdriveBindings extracts binding+id pairs and ignores non-hyperdrive bindings", () => {
  const text = `{
    "hyperdrive": [
      { "binding": "HYPERDRIVE_TENANT", "id": "<HYPERDRIVE_TENANT_ID>", "localConnectionString": "postgres://x" },
      { "binding": "HYPERDRIVE_INGEST", "id": "ff55e308" }
    ],
    "kv_namespaces": [{ "binding": "KV_AUTHZ", "id": "<KV_AUTHZ_ID>" }]
  }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_TENANT_ID>" },
    { binding: "HYPERDRIVE_INGEST", id: "ff55e308" },
  ]);
});

// The old implementation scanned with /HYPERDRIVE_[A-Z_]*_ID/ — which excludes digits, so a pool with a
// numeral in its name was invisible and silently never checked. Any future HYPERDRIVE_METER2 / _V2 must be seen.
test("hyperdriveBindings sees names containing DIGITS", () => {
  const text = `{"hyperdrive":[{"binding":"HYPERDRIVE_METER2","id":"<HYPERDRIVE_METER2_ID>"}]}`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_METER2", id: "<HYPERDRIVE_METER2_ID>" },
  ]);
});

test("hyperdriveBindings tolerates id-before-binding key order", () => {
  const text = `{"hyperdrive":[{"id":"abc","binding":"HYPERDRIVE_TENANT"}]}`;
  assert.deepEqual(hyperdriveBindings(text), [{ binding: "HYPERDRIVE_TENANT", id: "abc" }]);
});

test("hyperdriveBindings returns [] for a non-string", () => {
  assert.deepEqual(hyperdriveBindings(null), []);
});

// REGRESSION (round-3 review). Reading ONLY the top-level `hyperdrive` key was a NEW silent under-match:
// wrangler natively supports `env.<name>` sections, and apps/play/wrangler.jsonc already uses one. A binding
// declared there parses with ZERO errors and yielded ZERO bindings — so a tenant binding re-pointed at the
// cached pool inside an env section passed both layers green.
test("hyperdriveBindings sees bindings nested under an env.<name> section", () => {
  const text = `{
    "hyperdrive": [{ "binding": "HYPERDRIVE_TENANT", "id": "<HYPERDRIVE_TENANT_ID>" }],
    "env": {
      "production": {
        "hyperdrive": [{ "binding": "HYPERDRIVE_INGEST", "id": "<HYPERDRIVE_CACHED_ID>" }]
      }
    }
  }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_TENANT_ID>" },
    { binding: "HYPERDRIVE_INGEST", id: "<HYPERDRIVE_CACHED_ID>" },
  ]);
  // …and the re-pointing inside the env section is caught, not swallowed.
  assert.equal(bindingPlaceholderViolations([{ name: "web", text }]).length, 1);
});

// REGRESSION (round-5 review). Wrangler's own config-schema.json puts `previews` on BOTH RawConfig and
// RawEnvironment, each with a `hyperdrive` array — so a binding declared there was invisible to both layers.
test("hyperdriveBindings sees bindings under previews, incl. env.<name>.previews", () => {
  const text = `{
    "previews": { "hyperdrive": [{ "binding": "HYPERDRIVE_TENANT", "id": "<HYPERDRIVE_CACHED_ID>" }] },
    "env": { "staging": { "previews": { "hyperdrive": [
      { "binding": "HYPERDRIVE_INGEST", "id": "<HYPERDRIVE_INGEST_ID>" }
    ] } } }
  }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_CACHED_ID>" },
    { binding: "HYPERDRIVE_INGEST", id: "<HYPERDRIVE_INGEST_ID>" },
  ]);
  // the re-pointing inside previews is caught, not swallowed
  assert.equal(bindingPlaceholderViolations([{ name: "web", text }]).length, 1);
});

// A malformed ENTRY was silently dropped while a malformed KEY threw — the same swallow, one level down.
test("hyperdriveBindings THROWS on an entry missing a string binding or id", () => {
  assert.throws(
    () => hyperdriveBindings(`{"hyperdrive":[{"binding":"HYPERDRIVE_X"}]}`),
    /refusing to skip/,
  );
  assert.throws(() => hyperdriveBindings(`{"hyperdrive":[{"id":"y"}]}`), /refusing to skip/);
});

// `"hyperdrive"` present but NOT an array parses with zero errors. Silently reading it as "no bindings" is
// the same swallow; it is a malformed config and must be refused.
test("hyperdriveBindings THROWS when `hyperdrive` is present but not an array", () => {
  assert.throws(
    () => hyperdriveBindings(`{"hyperdrive":{"binding":"HYPERDRIVE_TENANT","id":"x"}}`),
    /not an array/,
  );
});

// REGRESSION (round-2 review, UNDER-match). The first implementation regex'd for flat `{...}` chunks. A brace
// inside a comment INSIDE a hyperdrive entry broke the chunk and silently dropped the binding from BOTH
// layers — so a tenant binding re-pointed at the cached pool produced ZERO violations. apps/engine and
// apps/auth already put prose comments inside these braces, so this was one `${VAR}` away from real.
test("a brace-bearing comment INSIDE an entry does not hide the binding", () => {
  const text = `{
    "hyperdrive": [
      {
        // built as \${INGEST_BASE_URL}/<token>; posture: caching: { disabled: true }
        "binding": "HYPERDRIVE_TENANT",
        "id": "<HYPERDRIVE_CACHED_ID>",
      },
    ],
  }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_CACHED_ID>" },
  ]);
  // and the re-pointing is still caught
  assert.equal(bindingPlaceholderViolations([{ name: "web", text }]).length, 1);
});

// REGRESSION (round-2 review, OVER-match). apps/mcp + apps/web document deploy-injected bindings as
// commented-out JSON in exactly the shape the old regex harvested — so a comment could turn `pnpm lint` RED
// for a binding that does not exist. A comment is a comment.
test("a commented-out binding is NOT a real binding", () => {
  const text = `{
    // "hyperdrive": [{ "binding": "HYPERDRIVE_PURGE", "id": "<HYPERDRIVE_CACHED_ID>" }],
    "hyperdrive": [{ "binding": "HYPERDRIVE_TENANT", "id": "<HYPERDRIVE_TENANT_ID>" }],
  }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_TENANT_ID>" },
  ]);
  assert.deepEqual(bindingPlaceholderViolations([{ name: "mcp", text }]), []);
});

test("hyperdriveBindings tolerates trailing commas (the configs use them)", () => {
  const text = `{ "hyperdrive": [{ "binding": "HYPERDRIVE_TENANT", "id": "<HYPERDRIVE_TENANT_ID>", },], }`;
  assert.deepEqual(hyperdriveBindings(text), [
    { binding: "HYPERDRIVE_TENANT", id: "<HYPERDRIVE_TENANT_ID>" },
  ]);
});

// Reporting bindings from a partial parse is how a guard silently checks less than it claims.
test("hyperdriveBindings THROWS on unparseable input rather than reporting a partial set", () => {
  assert.throws(() => hyperdriveBindings(`{ "hyperdrive": [ { "binding": `), /refusing to report/);
});

// ---------------------------------------------------------------- Layer 1: placeholder pinning (no network)

test("a binding pinned to its OWN placeholder is clean", () => {
  const text = `{"hyperdrive":[{"binding":"HYPERDRIVE_TENANT","id":"<HYPERDRIVE_TENANT_ID>"}]}`;
  assert.deepEqual(bindingPlaceholderViolations([{ name: "web", text }]), []);
});

// THE LEAK, caught at lint time with no API call: re-point the tenant binding at the cached pool's
// placeholder. gen-wrangler's per-app allow-list permits engine to use BOTH placeholders, so nothing else
// stops this. Every org-wide browse binds no org_id ⇒ its cache key is identical across orgs ⇒ org A's
// dashboard would render org B's rows.
test("a binding pointed at ANOTHER pool's placeholder is a violation", () => {
  const text = `{"hyperdrive":[{"binding":"HYPERDRIVE_TENANT","id":"<HYPERDRIVE_CACHED_ID>"}]}`;
  const violations = bindingPlaceholderViolations([{ name: "web", text }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /HYPERDRIVE_TENANT/);
  assert.match(violations[0], /HYPERDRIVE_CACHED_ID/);
});

test("HYPERDRIVE_CACHED pinned to its own placeholder is clean (it is a real, allowed pool)", () => {
  const text = `{"hyperdrive":[{"binding":"HYPERDRIVE_CACHED","id":"<HYPERDRIVE_CACHED_ID>"}]}`;
  assert.deepEqual(bindingPlaceholderViolations([{ name: "engine", text }]), []);
});

// A literal id in a committed config is a violation twice over: it dodges the pinning check, and real
// resource ids must never be committed (no-secrets — gen-wrangler-prod.mjs says so). The fixture below is
// deliberately NOT a real id: writing one here to test "don't commit real ids" would commit a real id.
test("a non-placeholder literal id in a COMMITTED config is a violation (no real ids in the repo)", () => {
  const text = `{"hyperdrive":[{"binding":"HYPERDRIVE_TENANT","id":"not-a-real-id-0000000000000000"}]}`;
  const violations = bindingPlaceholderViolations([{ name: "web", text }]);
  assert.equal(violations.length, 1);
});

// THE REAL DRIFT GUARD — asserts against the SHIPPED configs, so re-pointing any binding in any app goes red
// in `lint`, with no network and no deploy required. The previous version of this test asserted nothing (its
// own comment conceded it "held by construction"): the test NAME was the only thing making the claim.
test("every hyperdrive binding in every SHIPPED wrangler.jsonc is pinned to its own placeholder", async () => {
  const apps = ["engine", "api", "mcp", "web", "auth"];
  const configs = await Promise.all(
    apps.map(async (name) => ({
      name,
      text: await readFile(join(ROOT, `apps/${name}/wrangler.jsonc`), "utf8"),
    })),
  );
  const found = configs.flatMap((c) => hyperdriveBindings(c.text));
  assert.ok(found.length > 0, "expected the shipped configs to declare hyperdrive bindings");
  assert.ok(
    found.some((b) => b.binding === "HYPERDRIVE_TENANT"),
    "the tenant binding must be among them",
  );
  assert.deepEqual(bindingPlaceholderViolations(configs), []);

  // A STALE EXEMPTION is the quiet way this guard dies: if CACHING_ALLOWED_BINDINGS ever names a binding the
  // repo no longer declares (renamed, retired, or a typo), it silently exempts nothing — or worse, shadows a
  // real name. Every exemption must correspond to a binding that actually exists.
  for (const allowed of CACHING_ALLOWED_BINDINGS) {
    assert.ok(
      found.some((b) => b.binding === allowed),
      `${allowed} is exempt from the cache-posture check but no shipped wrangler.jsonc declares it — a stale ` +
        "exemption. Remove it, or fix the name.",
    );
  }
});

// ---------------------------------------------------------------- Layer 2: cache posture (deploy-time)

test("a tenant binding resolving to a caching-disabled pool is clean", () => {
  const violations = cachePostureViolations({
    bindings: [{ app: "web", binding: "HYPERDRIVE_TENANT", id: "t1" }],
    configsById: { t1: off("webhook-prod-tenant") },
  });
  assert.deepEqual(violations, []);
});

test("a tenant binding resolving to a CACHING pool is a violation", () => {
  const violations = cachePostureViolations({
    bindings: [{ app: "web", binding: "HYPERDRIVE_TENANT", id: "c1" }],
    configsById: { c1: on("webhook-prod-cached") },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /HYPERDRIVE_TENANT/);
  assert.match(violations[0], /caching is ENABLED/);
});

// Selection, enforced at deploy too: even if the placeholder pinning were bypassed (a hand-edited overlay),
// resolving the binding's ACTUAL id catches it — the id resolves to the cached pool, which reports caching on.
test("deploy-time selection: TENANT resolving to the cached pool's id is a violation", () => {
  const violations = cachePostureViolations({
    bindings: [
      { app: "web", binding: "HYPERDRIVE_TENANT", id: "c1" },
      { app: "engine", binding: "HYPERDRIVE_CACHED", id: "c1" },
    ],
    configsById: { c1: on("webhook-prod-cached") },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /HYPERDRIVE_TENANT/);
});

test("HYPERDRIVE_CACHED is the ONE binding allowed to cache", () => {
  const violations = cachePostureViolations({
    bindings: [{ app: "engine", binding: "HYPERDRIVE_CACHED", id: "c1" }],
    configsById: { c1: on("webhook-prod-cached") },
  });
  assert.deepEqual(violations, []);
});

test("FAILS CLOSED when a config can't be read", () => {
  const violations = cachePostureViolations({
    bindings: [{ app: "web", binding: "HYPERDRIVE_TENANT", id: "missing" }],
    configsById: {},
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not be read/);
});

// Hyperdrive caching is ON by default, so an absent/odd `caching` is the DANGEROUS case, never the benign one.
test("FAILS CLOSED on a missing or malformed caching field", () => {
  for (const config of [
    { name: "x" },
    { name: "x", caching: {} },
    { name: "x", caching: null },
    { name: "x", caching: { disabled: "true" } },
  ]) {
    const violations = cachePostureViolations({
      bindings: [{ app: "web", binding: "HYPERDRIVE_TENANT", id: "t1" }],
      configsById: { t1: config },
    });
    assert.equal(violations.length, 1, `expected a violation for ${JSON.stringify(config)}`);
  }
});

test("FAILS CLOSED on a prototype-key id rather than reading Object.prototype as a config", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const violations = cachePostureViolations({
      bindings: [{ app: "web", binding: "HYPERDRIVE_TENANT", id }],
      configsById: {},
    });
    assert.equal(violations.length, 1, `expected a violation for id ${id}`);
  }
});

test("FAILS CLOSED when bindings is absent or not an array", () => {
  assert.equal(cachePostureViolations({}).length, 1);
  assert.equal(cachePostureViolations({ bindings: null }).length, 1);
});

test("reports every offending binding, not just the first", () => {
  const violations = cachePostureViolations({
    bindings: [
      { app: "web", binding: "HYPERDRIVE_TENANT", id: "t1" },
      { app: "engine", binding: "HYPERDRIVE_INGEST", id: "i1" },
      { app: "auth", binding: "HYPERDRIVE_AUTHN", id: "a1" },
    ],
    configsById: { t1: on("tenant"), i1: on("ingest"), a1: off("authn") },
  });
  assert.equal(violations.length, 2);
});

// ---------------------------------------------------------------- pagination

// The Cloudflare list endpoint defaults to per_page=20 and the account is at 16 today. Paging off page 1
// would drop configs, and every dropped id fails closed — wedging EVERY prod deploy with an error pointing at
// a leak that does not exist.
// ---------------------------------------------------------------- the per-app floor

// REGRESSION (round-3 review). The floor was a GLOBAL binding count, so it only fired if EVERY app broke at
// once. Reviewer simulated the real case: move ONE app to wrangler.toml with its tenant binding re-pointed at
// the cached pool, and the guard printed "✔ all 2 binding(s) across 1 app config(s)" and exited 0 — the leak,
// green. Each DB-touching app must be found individually.
// Asserts DB_APPS against REALITY, not against itself: it must equal the set of apps whose SHIPPED
// wrangler.jsonc actually declares a hyperdrive binding. A tautological `deepEqual(DB_APPS, [...the same
// literal])` would be green and worthless — add a sixth DB-touching app and this goes red; retire one and it
// goes red too, so the floor can never quietly stop covering an app.
test("DB_APPS equals the apps whose SHIPPED wrangler.jsonc declares the TENANT binding", async () => {
  const appDirs = (await readdir(join(ROOT, "apps"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const withBindings = [];
  for (const name of appDirs) {
    let text;
    try {
      text = await readFile(join(ROOT, "apps", name, "wrangler.jsonc"), "utf8");
    } catch {
      continue; // not a Worker
    }
    if (hyperdriveBindings(text).some((b) => b.binding === REQUIRED_TENANT_BINDING)) {
      withBindings.push(name);
    }
  }
  assert.deepEqual([...DB_APPS].sort(), withBindings.sort());
});

const tenant = () => [{ binding: REQUIRED_TENANT_BINDING, id: "<HYPERDRIVE_TENANT_ID>" }];
const allDbApps = (over = {}) =>
  DB_APPS.map((name) => ({ name, bindings: over[name] ?? tenant() }));

test("missingDbApps flags a DB app absent from discovery", () => {
  const seen = allDbApps().filter((a) => a.name !== "web"); // renamed to wrangler.toml
  assert.deepEqual(missingDbApps(seen), ["web"]);
});

test("missingDbApps flags an app FOUND with zero bindings", () => {
  assert.deepEqual(missingDbApps(allDbApps({ web: [] })), ["web"]);
});

// THE ROUND-5 HOLE, as a regression. Counting bindings let an app whose ONLY binding is the cache-exempt
// HYPERDRIVE_CACHED satisfy the floor — while pinning passed (<HYPERDRIVE_CACHED_ID> IS its own placeholder)
// and the posture check skipped it (exempt BY NAME). All three layers returned zero violations for an app
// reading tenant data through the CACHING pool. The floor must demand the tenant binding by name.
test("missingDbApps flags an app whose ONLY binding is the cache-exempt one", () => {
  const cachedOnly = [{ binding: "HYPERDRIVE_CACHED", id: "<HYPERDRIVE_CACHED_ID>" }];
  assert.deepEqual(missingDbApps(allDbApps({ web: cachedOnly })), ["web"]);
});

test("missingDbApps is empty when every DB app declares the tenant binding", () => {
  assert.deepEqual(missingDbApps(allDbApps()), []);
});

// ---------------------------------------------------------------- pagination

test("configsByIdFromPages merges every page", () => {
  const byId = configsByIdFromPages([[{ id: "a", name: "one" }], [{ id: "b", name: "two" }]]);
  assert.deepEqual(Object.keys(byId).sort(), ["a", "b"]);
});

test("configsByIdFromPages yields a null-prototype map (a config id can never alias Object.prototype)", () => {
  const byId = configsByIdFromPages([[{ id: "a", name: "one" }]]);
  assert.equal(Object.getPrototypeOf(byId), null);
  assert.equal(byId["__proto__"], undefined);
});

/**
 * A fake CF list endpoint over `pages`, honouring ?page=.
 *
 * `withResultInfo: false` is the important mode: the previous version of this fake ALWAYS synthesised
 * `result_info.total_pages`, i.e. it manufactured the exact field the code depended on. That proved the loop
 * follows total_pages WHEN PRESENT — never that Cloudflare actually sends it. Paging must not hinge on a
 * field we have not verified the API emits.
 */
const fakeCf = (pages, calls = [], { withResultInfo = true, perPage = 100 } = {}) =>
  async function fakeFetch(url) {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const result = pages[page - 1] ?? [];
    return {
      ok: true,
      json: async () => ({
        success: true,
        result,
        ...(withResultInfo
          ? { result_info: { page, per_page: perPage, total_pages: pages.length } }
          : {}),
      }),
    };
  };

// The old fetch read page 1 only, with per_page defaulting to 20 against an account already at 16 configs —
// the 21st pool would have pushed ids off page 1, and every dropped id fails closed, WEDGING every prod
// deploy with an error pointing at a leak that does not exist.
test("fetchAllConfigs follows pagination and merges every page", async () => {
  const calls = [];
  // perPage=2 so page 1 is FULL — which is what tells the loop to ask for page 2. (The previous version of
  // this test handed back a 2-item page 1 at per_page=100, a response the API can never produce, and relied
  // on the fake's synthesised total_pages to keep walking.)
  const byId = await fetchAllConfigs(
    "acct",
    "tok",
    fakeCf([[{ id: "a" }, { id: "b" }], [{ id: "c" }]], calls, { perPage: 2 }),
    2,
  );
  assert.deepEqual(Object.keys(byId).sort(), ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /per_page=2/);
});

test("fetchAllConfigs asks for per_page=100 by default", async () => {
  const calls = [];
  await fetchAllConfigs("acct", "tok", fakeCf([[{ id: "a" }]], calls));
  assert.match(calls[0], /per_page=100/);
});

// Pins CF's REAL response shape, captured from the live account rather than invented:
//   {"page":1,"per_page":100,"count":16,"total_count":16,"total_pages":1}
// A round-3 review speculated total_pages was a field "only our own fake is known to emit"; it is not — the
// API sends it. The loop honours it AND the short-page fallback, so neither signal alone can truncate.
test("fetchAllConfigs stops on total_pages even when the page is FULL", async () => {
  const calls = [];
  const twoOfTwo = [{ id: "a" }, { id: "b" }];
  const fake = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: twoOfTwo,
        // A full page (perPage=2) that total_pages says is the LAST — without honouring total_pages the
        // short-page rule alone would issue a needless extra request.
        result_info: { page: 1, per_page: 2, count: 2, total_count: 2, total_pages: 1 },
      }),
    };
  };
  const byId = await fetchAllConfigs("acct", "tok", fake, 2);
  assert.deepEqual(Object.keys(byId).sort(), ["a", "b"]);
  assert.equal(calls.length, 1);
});

test("fetchAllConfigs stops after the last page (no infinite loop)", async () => {
  const calls = [];
  await fetchAllConfigs("acct", "tok", fakeCf([[{ id: "a" }]], calls));
  assert.equal(calls.length, 1);
});

// REGRESSION (round-3 review). Paging must NOT depend on `result_info.total_pages` — a field only our own
// fake was ever seen to emit. If CF omits it the old loop broke after page 1, every dropped id failed closed,
// and EVERY prod deploy died citing a leak that does not exist. A FULL page means "ask for the next one".
test("fetchAllConfigs pages correctly when the API sends NO result_info", async () => {
  const calls = [];
  const page1 = Array.from({ length: 3 }, (_, i) => ({ id: `p1-${i}` })); // full page (perPage=3)
  const page2 = [{ id: "p2-0" }]; // short page ⇒ the last
  const byId = await fetchAllConfigs(
    "acct",
    "tok",
    fakeCf([page1, page2], calls, { withResultInfo: false }),
    3,
  );
  assert.equal(Object.keys(byId).length, 4);
  assert.equal(calls.length, 2);
});

test("fetchAllConfigs stops on a SHORT first page without a second request", async () => {
  const calls = [];
  await fetchAllConfigs(
    "acct",
    "tok",
    fakeCf([[{ id: "a" }]], calls, { withResultInfo: false }),
    3,
  );
  assert.equal(calls.length, 1);
});

// A full LAST page (total is an exact multiple of per_page) must not loop forever: the next request returns
// empty and ends it.
test("fetchAllConfigs terminates when the last page is exactly full", async () => {
  const calls = [];
  const byId = await fetchAllConfigs(
    "acct",
    "tok",
    fakeCf([[{ id: "a" }, { id: "b" }], []], calls, { withResultInfo: false }),
    2,
  );
  assert.deepEqual(Object.keys(byId).sort(), ["a", "b"]);
  assert.equal(calls.length, 2);
});

test("fetchAllConfigs THROWS on an API error rather than reporting an empty, clean account", async () => {
  const failing = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    }),
  });
  await assert.rejects(
    () => fetchAllConfigs("acct", "tok", failing),
    /Cloudflare API error \(403\)/,
  );
});

// The error text must never carry the bearer token. CF error bodies don't echo it, but pin the shape so a
// future "include the whole body for debugging" edit can't quietly start leaking the credential into CI logs.
test("fetchAllConfigs' error text carries only CF's errors array, never the request", async () => {
  const failing = async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      success: false,
      errors: [{ message: "bad" }],
      token: "SHOULD-NOT-APPEAR",
    }),
  });
  await assert.rejects(
    () => fetchAllConfigs("acct", "SUPER-SECRET-TOKEN", failing),
    (err) => {
      assert.doesNotMatch(err.message, /SUPER-SECRET-TOKEN/);
      assert.doesNotMatch(err.message, /SHOULD-NOT-APPEAR/);
      return true;
    },
  );
});
