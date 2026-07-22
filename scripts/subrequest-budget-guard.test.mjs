import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BUDGET_MODEL,
  CONSTANT_SOURCES,
  REQUIRED_HEADROOM,
  budgetViolations,
  checkSubrequestBudget,
  evaluateBudget,
  numericConstants,
  readSubrequestCeiling,
} from "./subrequest-budget-guard.mjs";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const engineSource = () => readFileSync(repoFile("apps/engine/src/index.ts"), "utf8");
const wrangler = () => readFileSync(repoFile("apps/engine/wrangler.jsonc"), "utf8");

/** Every constant the model needs, read from the real sources — the same way the guard does it. */
function realConstants(overrides = {}) {
  const constants = new Map();
  for (const rel of CONSTANT_SOURCES) {
    for (const [k, v] of numericConstants(readFileSync(repoFile(rel), "utf8"), rel)) {
      if (!constants.has(k)) constants.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(overrides)) constants.set(k, v);
  return constants;
}

// The guard running against PRODUCTION.
test("the real committed repo fits its declared ceiling with the required headroom", () => {
  assert.deepEqual(checkSubrequestBudget(), []);
});

test("every constant the model references actually exists in the sources", () => {
  // Guards the guard: a model entry naming a constant nobody defines would silently contribute zero,
  // making the budget look smaller than it is. evaluateBudget fails closed, and this proves it passes now.
  const evaluated = evaluateBudget(realConstants());
  assert.equal(
    evaluated.reason,
    undefined,
    `model references a missing constant: ${evaluated.reason}`,
  );
  assert.equal(evaluated.rows.length, BUDGET_MODEL.length);
  assert.ok(evaluated.total > 0);
});

test("the per-org enumerations dominate the total — the term the old prose comment omitted", () => {
  // Recorded as an assertion because it is the whole reason the old estimate was wrong: the drains were
  // counted correctly and the 1,000-org loops were treated as one op each.
  const { rows } = evaluateBudget(realConstants());
  const byCron = Object.fromEntries(rows.map((r) => [r.cron, r.subrequests]));
  assert.ok(
    byCron["metering rollup"] > byCron["retention prune"],
    "expected the per-org rollup to outweigh the retention drain",
  );
});

// --- fail-closed floors ---

test("FAIL-CLOSED: no constants is a violation, not an empty pass", () => {
  assert.equal(numericConstants(""), null);
  assert.equal(evaluateBudget(new Map()).reason, "no-constants");
  assert.match(
    budgetViolations(evaluateBudget(new Map()), 50000)[0],
    /could not read any numeric constants/i,
  );
});

test("FAIL-CLOSED: a model entry naming a missing constant names it in the violation", () => {
  const constants = realConstants();
  constants.delete("RETENTION_ORG_LIMIT");
  const violations = budgetViolations(evaluateBudget(constants), 200000);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /RETENTION_ORG_LIMIT/);
  assert.match(violations[0], /no longer exists/i);
});

test("FAIL-CLOSED: an unreadable ceiling is a violation", () => {
  assert.equal(readSubrequestCeiling("no limits here"), null);
  assert.equal(readSubrequestCeiling('"subrequests": 0'), null);
  assert.equal(readSubrequestCeiling(42), null);
  assert.match(
    budgetViolations(evaluateBudget(realConstants()), null)[0],
    /could not read limits\.subrequests/i,
  );
});

// --- the checks that matter ---

test("a ceiling BELOW the worst case is reported", () => {
  const violations = budgetViolations(evaluateBudget(realConstants()), 1000);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ABOVE the declared ceiling/);
  assert.match(violations[0], /Largest contributors/);
});

test("a ceiling that merely EQUALS the worst case is reported — headroom is required", () => {
  // The failure this prevents: someone reads the guard's number and sets the ceiling to exactly it. The
  // ops factors are estimates, so a pinned ceiling turns a slightly-low estimate into a silent outage.
  const evaluated = evaluateBudget(realConstants());
  const violations = budgetViolations(evaluated, evaluated.total);
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`within ${REQUIRED_HEADROOM}x of`));
});

test("a ceiling at exactly the required headroom passes", () => {
  const evaluated = evaluateBudget(realConstants());
  assert.deepEqual(budgetViolations(evaluated, evaluated.total * REQUIRED_HEADROOM), []);
});

test("MUTATION: raising a real bound in the source pushes the budget over and is reported", () => {
  // The scenario the guard exists for — a one-character edit to a limit, with nothing else connecting it
  // to the ceiling. Here DEFAULT_METERING_ROLLUP_LIMIT goes 1,000 -> 20,000.
  const constants = realConstants({ DEFAULT_METERING_ROLLUP_LIMIT: 20000 });
  const ceiling = readSubrequestCeiling(wrangler());
  const violations = budgetViolations(evaluateBudget(constants), ceiling);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /metering rollup/);
  assert.match(violations[0], /10,000,000/, "should point at the real platform maximum");
});

test("numericConstants reads plain literals and folded products, from the real engine source", () => {
  const found = numericConstants(engineSource(), "index.ts");
  assert.equal(found.get("RETENTION_ORG_LIMIT"), 50);
  assert.equal(found.get("RETENTION_BATCHES_PER_ORG"), 40);
  // A product of literals must fold, or the model silently loses the constant.
  assert.equal(found.get("ORPHAN_SWEEP_SAFETY_WINDOW_MS"), 24 * 60 * 60 * 1000);
});

test("numericConstants ignores non-numeric initialisers rather than guessing", () => {
  const found = numericConstants(
    'const A = 5; const B = someCall(); const C = "x"; const D = 2 * 3;',
  );
  assert.equal(found.get("A"), 5);
  assert.equal(found.has("B"), false);
  assert.equal(found.has("C"), false);
  assert.equal(found.get("D"), 6);
});
