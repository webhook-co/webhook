import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { check, requiredEnvNames, workflowsRunningGenerator } from "./deploy-env-parity-guard.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The invariant, proven against the REAL repository — this is the guard running against production.
test("the actual repository passes the guard", () => {
  assert.deepEqual(check(), []);
});

test("finds the generator's reqEnv names", () => {
  const names = requiredEnvNames('reqEnv("A_ID") reqEnv( "B_ID" )\nreqEnv("A_ID")');
  assert.deepEqual(names, ["A_ID", "A_ID", "B_ID"]);
});

// The previous version of this asserted `requiredEnvNames.length >= 0`, which reads the FUNCTION'S
// ARITY, not its result — an assertion that cannot fail. It is the floor for everything below, so it
// has to actually call the thing.
test("the real generator requires a plausible number of vars", () => {
  const names = requiredEnvNames(
    readFileSync(join(REPO_ROOT, "scripts", "gen-wrangler-prod.mjs"), "utf8"),
  );
  assert.ok(names.length >= 5, `expected >= 5 reqEnv names, got ${names.length}`);
  assert.ok(names.includes("KV_HEALTH_ID"));
  assert.ok(workflowsRunningGenerator().length >= 2);
});

function fixture(workflows) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(dir, name), body);
  return dir;
}

const GENERATOR_VARS = ["A_ID", "B_ID", "C_ID", "D_ID", "E_ID"];
const FAKE_GEN = GENERATOR_VARS.map((v) => `reqEnv("${v}")`).join("\n");
const wfBody = (vars) =>
  `run: node scripts/gen-wrangler-prod.mjs\nenv:\n${vars.map((v) => `  ${v}: x`).join("\n")}\n`;

// This is the exact shape of the real failure: the workflow you changed passes, and two unrelated
// deploys break on an id for a Worker they do not even ship.
test("flags a workflow that runs the generator but misses a required var", () => {
  const dir = fixture({
    "a.yml": wfBody(GENERATOR_VARS),
    "b.yml": wfBody(GENERATOR_VARS.slice(0, 4)), // missing E_ID
  });
  const problems = check({ workflowsDir: dir, generatorSource: FAKE_GEN });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b\.yml/);
  assert.match(problems[0], /E_ID/);
});

test("passes when every workflow supplies every required var", () => {
  const dir = fixture({ "a.yml": wfBody(GENERATOR_VARS), "b.yml": wfBody(GENERATOR_VARS) });
  assert.deepEqual(check({ workflowsDir: dir, generatorSource: FAKE_GEN }), []);
});

test("ignores workflows that do not run the generator", () => {
  const dir = fixture({
    "a.yml": wfBody(GENERATOR_VARS),
    "b.yml": wfBody(GENERATOR_VARS),
    "unrelated.yml": "run: echo hi\n",
  });
  assert.deepEqual(check({ workflowsDir: dir, generatorSource: FAKE_GEN }), []);
});

// Silence must not read as success.
test("fails loudly when no workflow appears to run the generator", () => {
  const dir = fixture({ "only.yml": "run: echo hi\n" });
  const problems = check({ workflowsDir: dir, generatorSource: FAKE_GEN });
  assert.match(problems.join(" "), /discovery floor/);
});
