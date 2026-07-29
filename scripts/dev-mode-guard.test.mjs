import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  deployedConfigs,
  findViolations,
  forbiddenKeysIn,
  FORBIDDEN_IN_DEPLOYED_CONFIG,
} from "./dev-mode-guard.mjs";

// A guard's tests must RUN the guard, not restate its list.

/** Seed the per-source floors a synthetic tree must clear before a violation can be the thing under test. */
function seedFloors(dir, { apps = 10, workflows = 10 } = {}) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (let i = 0; i < workflows; i += 1) {
    writeFileSync(join(dir, ".github", "workflows", `w${i}.yml`), "name: x\n");
  }
  for (let i = 0; i < apps; i += 1) {
    mkdirSync(join(dir, "apps", `app${i}`), { recursive: true });
    writeFileSync(join(dir, "apps", `app${i}`, "wrangler.jsonc"), "{}\n");
  }
  writeFileSync(join(dir, "scripts", "gen-wrangler-prod.mjs"), "// clean\n");
}

test("the real repo is clean", () => {
  assert.deepEqual(findViolations(), []);
});

test("discovery finds the real configs, and the floor is real", () => {
  const configs = deployedConfigs();
  assert.ok(configs.length >= 9, `expected the real config set, got ${configs.length}`);
  assert.ok(
    configs.some((c) => c.path === "apps/engine/wrangler.jsonc"),
    "must find the engine config — it is the one that holds the KMS bindings",
  );
  assert.ok(
    configs.some((c) => c.path === "scripts/gen-wrangler-prod.mjs"),
    "must scan the deploy overlay too",
  );
});

test("the generated .prod. overlay is excluded — it is gitignored output, not a source", () => {
  assert.ok(!deployedConfigs().some((c) => c.path.includes(".prod.")));
});

test("flags a forbidden key in a vars block", () => {
  // The real failure mode: the overlay only PREPENDS, so a committed `vars` entry ships verbatim.
  const keys = forbiddenKeysIn('{ "vars": { "KMS_MODE": "local" } }');
  assert.deepEqual(keys, ["KMS_MODE"]);
});

test("flags LOCAL_KEK anywhere, including a secrets list", () => {
  assert.deepEqual(forbiddenKeysIn('secrets: ["CREDENTIAL_PEPPER", "LOCAL_KEK"]'), ["LOCAL_KEK"]);
});

test("flags every key when all are present", () => {
  assert.deepEqual(
    forbiddenKeysIn("KMS_MODE LOCAL_KEK EMAIL_MODE OAUTH_MODE"),
    FORBIDDEN_IN_DEPLOYED_CONFIG,
  );
});

test("flags EMAIL_MODE in a vars block — log mode in prod leaks sign-in links into logs", () => {
  assert.deepEqual(forbiddenKeysIn('{ "vars": { "EMAIL_MODE": "log" } }'), ["EMAIL_MODE"]);
});

test("flags OAUTH_MODE in a vars block", () => {
  assert.deepEqual(forbiddenKeysIn('{ "vars": { "OAUTH_MODE": "optional" } }'), ["OAUTH_MODE"]);
});

test("clean text yields nothing — the guard is not flagging everything", () => {
  // Anti-vacuity in the other direction: a guard that always fires is as useless as one that never does.
  assert.deepEqual(forbiddenKeysIn('{ "vars": { "INGEST_BASE_URL": "https://wbhk.my" } }'), []);
});

test("findViolations reports a planted violation, with its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    seedFloors(dir);
    assert.deepEqual(findViolations(dir), [], "the synthetic tree should start clean");

    writeFileSync(
      join(dir, "apps", "app3", "wrangler.jsonc"),
      '{ "vars": { "KMS_MODE": "local" } }\n',
    );
    assert.deepEqual(findViolations(dir), [
      { path: "apps/app3/wrangler.jsonc", keys: ["KMS_MODE"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The floor that actually matters: if the apps/ loop broke, the ~21 workflows alone would satisfy any
// TOTAL floor and the guard would report green while scanning zero Worker configs.
test("the app-config floor fires even when plenty of workflows are found", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    mkdirSync(join(dir, "apps"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, "scripts", "gen-wrangler-prod.mjs"), "// clean\n");
    for (let i = 0; i < 21; i += 1) {
      writeFileSync(join(dir, ".github", "workflows", `w${i}.yml`), "name: x\n");
    }
    // 22 files discovered, zero of them a Worker config.
    assert.equal(deployedConfigs(dir).length, 22);
    assert.throws(() => findViolations(dir), /at least 9 app-config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow floor fires when the workflows directory disappears", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    seedFloors(dir, { workflows: 0 });
    assert.throws(() => findViolations(dir), /at least 10 workflow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the overlay floor fires when the overlay is not found", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    assert.throws(() => findViolations(dir), /ENOENT|at least 1 overlay/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real repo clears every per-source floor", () => {
  const bySource = {};
  for (const c of deployedConfigs()) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  assert.ok(bySource["app-config"] >= 9, `app-config: ${bySource["app-config"]}`);
  assert.equal(bySource.overlay, 1);
  assert.ok(bySource.workflow >= 10, `workflow: ${bySource.workflow}`);
});

test("the zero-input floor fires when discovery breaks", () => {
  // Without this, a glob that stopped matching would make the guard pass on an empty set — green,
  // and completely blind.
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    mkdirSync(join(dir, "apps"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "gen-wrangler-prod.mjs"), "// clean\n");
    assert.throws(() => findViolations(dir), /at least 9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a violation in the deploy overlay is caught too", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmodeguard-"));
  try {
    seedFloors(dir);
    writeFileSync(
      join(dir, "scripts", "gen-wrangler-prod.mjs"),
      "const vars = { KMS_MODE: process.env.KMS_MODE };\n",
    );
    assert.deepEqual(findViolations(dir), [
      { path: "scripts/gen-wrangler-prod.mjs", keys: ["KMS_MODE"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
