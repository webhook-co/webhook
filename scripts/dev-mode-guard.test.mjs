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
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "gen-wrangler-prod.mjs"), "// clean\n");
    for (let i = 0; i < 10; i += 1) {
      mkdirSync(join(dir, "apps", `app${i}`), { recursive: true });
      writeFileSync(join(dir, "apps", `app${i}`, "wrangler.jsonc"), "{}\n");
    }
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
    mkdirSync(join(dir, "scripts"), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      mkdirSync(join(dir, "apps", `app${i}`), { recursive: true });
      writeFileSync(join(dir, "apps", `app${i}`, "wrangler.jsonc"), "{}\n");
    }
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
