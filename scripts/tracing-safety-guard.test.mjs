// Tests for scripts/tracing-safety-guard.mjs — the lint-time guard that keeps Cloudflare native tracing
// (`observability.traces.enabled`) OFF any Worker that carries a secret in its URL path or query string.
//
// WHY: CF's automatic tracing emits a fetch span recording `url.full`/`url.path`/`url.query` verbatim, with NO
// application redaction hook. So enabling tracing on a Worker whose URL ever contains a token/code/ticket
// exfiltrates a live credential into the trace store (S6 · ADR-0124/0125). The apps were audited firsthand
// (2026-07-19): api/www/get/telemetry carry NO URL secret; engine (ingest token = first path segment),
// auth (?code/?state), web (?ticket/?token), mcp, and play (sandbox token in path) DO. This guard turns that
// audit into a checked property: tracing may be enabled ONLY on the audited-safe allowlist, it MUST stay on
// where we shipped it, and a brand-new Worker is a red build until it is deliberately classified.
//
// Fixture-driven pure-function tests (exactly what the lint guard calls) PLUS live assertions over the real
// shipped apps/*/wrangler.jsonc, so a real regression is a red build rather than a fixture agreeing with itself.

import assert from "node:assert/strict";
import test from "node:test";

import {
  TRACING_SAFE_APPS,
  TRACING_ENABLED_APPS,
  TRACING_FORBIDDEN_APPS,
  TRACING_NO_FETCH_APPS,
  classifyApp,
  tracesEnabledAnySection,
  tracesConfigPresentAnySection,
  tracesEnabledDeployable,
  headSamplingRate,
  tracingSafetyViolations,
  readAppConfigs,
  lintMain,
} from "./tracing-safety-guard.mjs";

// A committed wrangler.jsonc for `app` with tracing enabled (deployable, top-level) at `rate`.
const withTraces = (name, rate = 0.2) => ({
  name,
  file: "wrangler.jsonc",
  text: `{
    "name": "webhook-${name}",
    "observability": { "enabled": true, "traces": { "enabled": true, "head_sampling_rate": ${rate} } }
  }`,
});
// A committed wrangler.jsonc for `app` with NO tracing (Workers Logs only, or nothing).
const noTraces = (name) => ({
  name,
  file: "wrangler.jsonc",
  text: `{ "name": "webhook-${name}", "observability": { "enabled": true } }`,
});

/** A full, clean repo snapshot: every app classified, tracing on exactly the enabled set with a valid rate. */
const cleanRepo = () => [
  withTraces("api"),
  withTraces("www", 0.05),
  withTraces("get", 0.05),
  noTraces("telemetry"), // SAFE but deliberately not enabled in v1
  noTraces("engine"),
  noTraces("auth"),
  noTraces("web"),
  noTraces("mcp"),
  noTraces("play"),
  noTraces("dmarc"),
];

// ------------------------------------------------------------------ classification

test("every audited app is classified into exactly one bucket", () => {
  const buckets = [TRACING_SAFE_APPS, TRACING_FORBIDDEN_APPS, TRACING_NO_FETCH_APPS];
  const all = [...TRACING_SAFE_APPS, ...TRACING_FORBIDDEN_APPS, ...TRACING_NO_FETCH_APPS];
  // No app appears in two buckets.
  assert.equal(new Set(all).size, all.length, "an app is in more than one classification bucket");
  for (const name of all) {
    const hits = buckets.filter((b) => b.has(name)).length;
    assert.equal(hits, 1, `${name} must be in exactly one bucket`);
  }
});

test("the enabled set is a subset of the safe set (never ship tracing on an unaudited worker)", () => {
  for (const name of TRACING_ENABLED_APPS) {
    assert.ok(TRACING_SAFE_APPS.has(name), `${name} is enabled but not in the safe allowlist`);
  }
});

test("classifyApp returns the bucket, or 'unclassified' for an unknown worker", () => {
  assert.equal(classifyApp("api"), "safe");
  assert.equal(classifyApp("engine"), "forbidden");
  assert.equal(classifyApp("dmarc"), "no-fetch");
  assert.equal(classifyApp("brand-new-worker"), "unclassified");
});

// ------------------------------------------------------------------ traces detection (parse, not scan)

test("tracesEnabledDeployable reads the TOP-LEVEL observability.traces.enabled", () => {
  assert.equal(tracesEnabledDeployable(withTraces("api").text), true);
  assert.equal(tracesEnabledDeployable(noTraces("api").text), false);
  assert.equal(
    tracesEnabledDeployable(`{ "observability": { "traces": { "enabled": false } } }`),
    false,
  );
});

test("tracesEnabledAnySection also catches tracing hidden in an env.<name> section (security union)", () => {
  const envOnly = `{
    "name": "webhook-engine",
    "env": { "production": { "observability": { "traces": { "enabled": true } } } }
  }`;
  // The deployable check (top-level, what a plain \`wrangler deploy\` ships) does NOT see it...
  assert.equal(tracesEnabledDeployable(envOnly), false);
  // ...but the security union DOES — a leak inside an env section is still a leak.
  assert.equal(tracesEnabledAnySection(envOnly), true);
});

test("traces detection is enabled===true strict, never truthy", () => {
  assert.equal(
    tracesEnabledDeployable(`{ "observability": { "traces": { "enabled": 1 } } }`),
    false,
  );
  assert.equal(
    tracesEnabledDeployable(`{ "observability": { "traces": { "enabled": "true" } } }`),
    false,
  );
});

test("headSamplingRate returns the top-level rate or undefined", () => {
  assert.equal(headSamplingRate(withTraces("api", 0.2).text), 0.2);
  assert.equal(headSamplingRate(noTraces("api").text), undefined);
});

test("a malformed wrangler config throws rather than reading as 'no tracing' (fail loud)", () => {
  assert.throws(() => tracesEnabledDeployable(`{ "observability": { not json `));
});

// ------------------------------------------------------------------ the core policy: tracingSafetyViolations

test("a clean repo has zero violations", () => {
  assert.deepEqual(tracingSafetyViolations(cleanRepo()), []);
});

test("tracing on a FORBIDDEN worker is a violation naming the url-secret risk", () => {
  const configs = cleanRepo().map((c) => (c.name === "engine" ? withTraces("engine") : c));
  const v = tracingSafetyViolations(configs);
  assert.equal(v.length, 1);
  assert.match(v[0], /engine/);
  assert.match(v[0], /url\.path|token|secret/i);
});

test("a traces block PRESENT-but-not-strictly-enabled on a forbidden worker is still a violation", () => {
  // Defense-in-depth: enabled:1 (truthy, not === true) reads as 'off' to the enabled check, but the block
  // must simply not exist on a url-secret worker. And enabled:false is likewise a block that must be removed.
  for (const bad of [
    `{ "observability": { "traces": { "enabled": 1 } } }`,
    `{ "observability": { "traces": { "enabled": false } } }`,
  ]) {
    const configs = cleanRepo().map((c) =>
      c.name === "web" ? { name: "web", file: "wrangler.jsonc", text: bad } : c,
    );
    const v = tracingSafetyViolations(configs);
    assert.ok(
      v.some((m) => m.includes("web") && /traces block is present/i.test(m)),
      `config ${bad} should violate on a forbidden worker`,
    );
  }
});

test("tracesConfigPresentAnySection is presence-based, not enabled-based", () => {
  assert.equal(
    tracesConfigPresentAnySection(`{ "observability": { "traces": { "enabled": false } } }`),
    true,
  );
  assert.equal(
    tracesConfigPresentAnySection(`{ "observability": { "traces": { "enabled": 1 } } }`),
    true,
  );
  assert.equal(tracesConfigPresentAnySection(`{ "observability": { "enabled": true } }`), false);
  assert.equal(tracesConfigPresentAnySection(`{}`), false);
  // ...and it sees a block hidden in an env section.
  assert.equal(
    tracesConfigPresentAnySection(
      `{ "env": { "production": { "observability": { "traces": {} } } } }`,
    ),
    true,
  );
});

test("tracing enabled inside an env section of a forbidden worker is still caught (union)", () => {
  const configs = cleanRepo().map((c) =>
    c.name === "auth"
      ? {
          name: "auth",
          file: "wrangler.jsonc",
          text: `{ "env": { "production": { "observability": { "traces": { "enabled": true } } } } }`,
        }
      : c,
  );
  const v = tracingSafetyViolations(configs);
  assert.equal(v.length, 1);
  assert.match(v[0], /auth/);
});

test("a brand-new UNCLASSIFIED worker is a violation even with tracing OFF (forces the audit)", () => {
  const v = tracingSafetyViolations([...cleanRepo(), noTraces("newthing")]);
  assert.equal(v.length, 1);
  assert.match(v[0], /newthing/);
  assert.match(v[0], /classif/i);
});

test("an enabled worker that LOST its tracing is a floor violation (catches silent removal)", () => {
  const configs = cleanRepo().map((c) => (c.name === "api" ? noTraces("api") : c));
  const v = tracingSafetyViolations(configs);
  assert.equal(v.length, 1);
  assert.match(v[0], /api/);
});

test("an enabled worker missing from the configs entirely is a floor violation (zero-input floor)", () => {
  // Empty input: every enabled worker (api/www/get) is missing → violations, never a silent clean pass.
  const v = tracingSafetyViolations([]);
  assert.ok(v.length >= TRACING_ENABLED_APPS.size);
  for (const name of TRACING_ENABLED_APPS) assert.ok(v.some((m) => m.includes(name)));
});

test("an env-only enable does NOT satisfy the floor (only a deployable top-level enable counts)", () => {
  const configs = cleanRepo().map((c) =>
    c.name === "get"
      ? {
          name: "get",
          file: "wrangler.jsonc",
          text: `{ "env": { "production": { "observability": { "traces": { "enabled": true } } } } }`,
        }
      : c,
  );
  const v = tracingSafetyViolations(configs);
  // get is SAFE so the union-enable is not a security violation, but it never ships → floor violation.
  assert.ok(v.some((m) => m.includes("get")));
});

test("tracing without a deliberate head_sampling_rate is a violation", () => {
  const configs = cleanRepo().map((c) =>
    c.name === "api"
      ? {
          name: "api",
          file: "wrangler.jsonc",
          text: `{ "observability": { "traces": { "enabled": true } } }`,
        }
      : c,
  );
  const v = tracingSafetyViolations(configs);
  assert.ok(v.some((m) => m.includes("api") && /sampl/i.test(m)));
});

test("an out-of-range sampling rate is a violation (0 traces nothing; >1 is invalid)", () => {
  for (const bad of [0, 1.5, -0.1]) {
    const configs = cleanRepo().map((c) => (c.name === "api" ? withTraces("api", bad) : c));
    const v = tracingSafetyViolations(configs);
    assert.ok(
      v.some((m) => m.includes("api") && /sampl/i.test(m)),
      `rate ${bad} should violate`,
    );
  }
});

test("a 100% rate (1) is allowed — valid, just un-sampled", () => {
  const configs = cleanRepo().map((c) => (c.name === "api" ? withTraces("api", 1) : c));
  assert.deepEqual(tracingSafetyViolations(configs), []);
});

test("a string head_sampling_rate is a violation (exercises the typeof branch)", () => {
  const configs = cleanRepo().map((c) =>
    c.name === "api"
      ? {
          name: "api",
          file: "wrangler.jsonc",
          text: `{ "observability": { "traces": { "enabled": true, "head_sampling_rate": "0.2" } } }`,
        }
      : c,
  );
  assert.ok(tracingSafetyViolations(configs).some((m) => m.includes("api") && /sampl/i.test(m)));
});

test("a SAFE worker enabling traces only in an env section with a bad rate is still caught (union sampling)", () => {
  // telemetry is SAFE-but-not-enabled: security skips it, the floor skips it (env-only, not deployable), so the
  // SAMPLING check is the only thing that can catch a missing rate on an env-only enable. It must.
  const configs = cleanRepo().map((c) =>
    c.name === "telemetry"
      ? {
          name: "telemetry",
          file: "wrangler.jsonc",
          text: `{ "env": { "production": { "observability": { "traces": { "enabled": true } } } } }`,
        }
      : c,
  );
  const v = tracingSafetyViolations(configs);
  assert.ok(v.some((m) => m.includes("telemetry") && /sampl/i.test(m)));
});

test("non-array input fails closed", () => {
  assert.ok(tracingSafetyViolations(null).length > 0);
});

// ------------------------------------------------------------------ live assertions over the REAL repo

test("the real repo passes the guard end-to-end", async () => {
  const configs = await readAppConfigs();
  assert.ok(configs.length > 0, "discovered zero wrangler configs — the reader is broken");
  assert.deepEqual(tracingSafetyViolations(configs), []);
});

test("the three shipped workers really do have tracing enabled with a valid rate", async () => {
  const configs = await readAppConfigs();
  for (const name of TRACING_ENABLED_APPS) {
    const main = configs.find((c) => c.name === name && c.file === "wrangler.jsonc");
    assert.ok(main, `no wrangler.jsonc found for enabled app ${name}`);
    assert.equal(tracesEnabledDeployable(main.text), true, `${name} tracing is off`);
    const rate = headSamplingRate(main.text);
    assert.ok(typeof rate === "number" && rate > 0 && rate <= 1, `${name} rate ${rate} invalid`);
  }
});

test("the forbidden workers really do NOT have tracing enabled anywhere", async () => {
  const configs = await readAppConfigs();
  for (const c of configs) {
    if (TRACING_FORBIDDEN_APPS.has(c.name)) {
      assert.equal(
        tracesEnabledAnySection(c.text),
        false,
        `${c.name}/${c.file} carries a URL secret — tracing must never be enabled on it`,
      );
    }
  }
});

test("every real app with a wrangler config is classified (no unclassified worker in the repo)", async () => {
  const configs = await readAppConfigs();
  for (const c of configs) {
    assert.notEqual(
      classifyApp(c.name),
      "unclassified",
      `${c.name} is not classified in the guard`,
    );
  }
});

test("lintMain exits non-zero when a violation exists, zero when clean", async () => {
  let code = null;
  const errors = [];
  await lintMain({
    readConfigs: async () =>
      cleanRepo().map((c) => (c.name === "engine" ? withTraces("engine") : c)),
    log: () => {},
    error: (m) => errors.push(m),
    exit: (c) => {
      code = c;
    },
  });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => /engine/.test(m)));

  code = null;
  await lintMain({
    readConfigs: async () => cleanRepo(),
    log: () => {},
    error: () => {},
    exit: (c) => (code = c),
  });
  assert.equal(code, null, "a clean repo must not call exit(1)");
});
