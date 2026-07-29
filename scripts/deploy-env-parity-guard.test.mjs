import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  check,
  optionalEnvNames,
  requiredEnvNames,
  workflowsRunningGenerator,
} from "./deploy-env-parity-guard.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The real generator source, so a fixture can ADD one variable to it without losing the floors. */
const realGeneratorSource = () =>
  readFileSync(join(REPO_ROOT, "scripts", "gen-wrangler-prod.mjs"), "utf8");

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
// The fake generator must be realistic on BOTH halves: it reads required vars via reqEnv() and optional
// ones via process.env. A fixture with no optional vars would trip the optional discovery floor, and
// relaxing that floor to accommodate a fixture would be weakening the guard to suit its own test.
const GENERATOR_OPTIONAL = ["P_FLAG", "Q_FLAG", "R_FLAG", "S_FLAG", "T_FLAG"];
const FAKE_GEN = [
  ...GENERATOR_VARS.map((v) => `reqEnv("${v}")`),
  ...GENERATOR_OPTIONAL.map((v) => `process.env.${v} ?? ""`),
].join("\n");
/**
 * Required vars are matched by substring, so their indentation is irrelevant. Optional vars are matched as
 * a real `NAME: ${{ vars.NAME }}` line at six spaces, which is what a workflow `env:` block looks like —
 * so they are emitted in that exact shape.
 */
const wfBody = (vars, optional = GENERATOR_OPTIONAL) =>
  `run: node scripts/gen-wrangler-prod.mjs\nenv:\n${vars.map((v) => `  ${v}: x`).join("\n")}\n` +
  optional.map((v) => `      ${v}: \${{ vars.${v} }}`).join("\n") +
  "\n";

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

// ---------------------------------------------------------------- optional vars (the SILENT half)
//
// `reqEnv()` names throw when absent, so they fail loudly. `process.env.X` names do not: they
// substitute to "" and the feature ships DARK. OPENAI_APPS_CHALLENGE_TOKEN (ADR-0132) was read by the
// generator and forwarded by NO workflow, and every gate stayed green.
//
// Semantics differ deliberately. A required var must be in EVERY workflow (the generator emits all apps
// and throws). An optional var needs only the workflow that deploys the app using it — which is how
// ORPHAN_SWEEP_DELETE (deploy.yml) and STRIPE_PLANS (deploy-web.yml) are already wired.

test("finds the generator's optional process.env names", () => {
  const names = optionalEnvNames('process.env.A_FLAG ?? "" process.env.B_MODE\nprocess.env.A_FLAG');
  assert.deepEqual(names, ["A_FLAG", "B_MODE"]);
});

test("the real generator reads a plausible number of optional vars", () => {
  const names = optionalEnvNames(
    readFileSync(join(REPO_ROOT, "scripts", "gen-wrangler-prod.mjs"), "utf8"),
  );
  assert.ok(names.length >= 5, `expected >= 5 optional names, got ${names.length}`);
  assert.ok(names.includes("OPENAI_APPS_CHALLENGE_TOKEN"));
});

test("an optional var no workflow forwards FAILS", () => {
  const problems = check({
    generatorSource: `${realGeneratorSource()}\nconst x = process.env.TOTALLY_UNFORWARDED_VAR ?? "";`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TOTALLY_UNFORWARDED_VAR/);
  assert.match(problems[0], /dark/i);
});

test("an optional var forwarded by only ONE workflow is accepted", () => {
  // ORPHAN_SWEEP_DELETE is in deploy.yml alone. Demanding it everywhere would be wrong, and would
  // force noise into workflows that do not deploy the Worker that reads it.
  const problems = check({
    generatorSource: `${realGeneratorSource()}\nconst y = process.env.ORPHAN_SWEEP_DELETE ?? "";`,
  });
  assert.deepEqual(problems, []);
});

test("discovery floor: a generator with no optional vars fails rather than passing vacuously", () => {
  const problems = check({
    generatorSource: 'reqEnv("A_ID") reqEnv("B_ID") reqEnv("C_ID") reqEnv("D_ID") reqEnv("E_ID")',
  });
  assert.ok(
    problems.some((p) => /discovery floor/.test(p) && /optional/i.test(p)),
    `expected an optional-var discovery floor, got: ${problems.join(" | ")}`,
  );
});
