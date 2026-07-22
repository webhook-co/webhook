import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CAP_TICK_CRONS,
  HOURLY_ONLY_CRONS,
  analyseScheduledDispatch,
  checkCronDispatch,
  dispatchViolations,
} from "./cron-dispatch-guard.mjs";

const ENGINE_INDEX = fileURLToPath(new URL("../apps/engine/src/index.ts", import.meta.url));
const realSource = () => readFileSync(ENGINE_INDEX, "utf8");

// The guard running against PRODUCTION — the committed engine source must satisfy it.
test("the real committed engine source has zero violations", () => {
  assert.deepEqual(checkCronDispatch(), []);
});

test("the real source dispatches exactly the expected crons on each side of the early return", () => {
  const found = analyseScheduledDispatch(realSource());
  assert.notEqual(found, null);
  assert.deepEqual([...found.capTick].sort(), [...CAP_TICK_CRONS].sort());
  assert.deepEqual([...found.hourlyOnly].sort(), [...HOURLY_ONLY_CRONS].sort());
  assert.deepEqual(found.missingCatch, []);
});

// --- fail-closed floors: a guard that cannot read its input must NEVER report success ---

test("FAIL-CLOSED: unparseable / empty source yields null, not an empty pass", () => {
  assert.equal(analyseScheduledDispatch(""), null);
  assert.equal(analyseScheduledDispatch("const x = 1;"), null);
});

test("FAIL-CLOSED: a null analysis is a violation, not a vacuous pass", () => {
  const violations = dispatchViolations(null);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read the scheduled\(\) dispatch/i);
});

test("FAIL-CLOSED: an analysis with no dispatched crons is a violation", () => {
  const violations = dispatchViolations({ capTick: [], hourlyOnly: [], missingCatch: [] });
  assert.ok(violations.length > 0);
});

// --- real source mutations must be caught ---

test("MUTATION: deleting a waitUntil block is reported as a missing cron", () => {
  const mutated = realSource().replace(
    /\n\s*ctx\.waitUntil\(\n\s*runOrgReaperDrainCron\(env\)[\s\S]*?\n\s*\);/,
    "",
  );
  assert.notEqual(mutated, realSource(), "mutation did not apply");
  const violations = dispatchViolations(analyseScheduledDispatch(mutated));
  assert.ok(
    violations.some((v) => v.includes("runOrgReaperDrainCron") && /never dispatched/i.test(v)),
    `expected a 'never dispatched' violation, got: ${JSON.stringify(violations)}`,
  );
});

test("MUTATION: dropping a .catch() is reported", () => {
  const mutated = realSource().replace(
    `ctx.waitUntil(
      runAuditAnchorCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "audit anchor cron failed", error: String(err) })),
      ),
    );`,
    "ctx.waitUntil(runAuditAnchorCron(env));",
  );
  assert.notEqual(mutated, realSource(), "mutation did not apply");
  const violations = dispatchViolations(analyseScheduledDispatch(mutated));
  assert.ok(
    violations.some((v) => v.includes("runAuditAnchorCron") && /catch/i.test(v)),
    `expected a missing-catch violation, got: ${JSON.stringify(violations)}`,
  );
});

test("MUTATION: promoting an hourly cron above the early return is reported (the 12x bug)", () => {
  const src = realSource();
  const block = `    ctx.waitUntil(
      runRetentionPruneDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "retention prune cron failed", error: String(err) })),
      ),
    );`;
  assert.ok(src.includes(block), "retention prune block not found");
  const anchor = `    if (!plan.runsHourly) return;`;
  const mutated = src.replace(block + "\n", "").replace(anchor, block + "\n" + anchor);
  const violations = dispatchViolations(analyseScheduledDispatch(mutated));
  assert.ok(
    violations.some(
      (v) => v.includes("runRetentionPruneDrainCron") && /every 5 minutes|cap tick/i.test(v),
    ),
    `expected a 12x-placement violation, got: ${JSON.stringify(violations)}`,
  );
});

test("MUTATION: an unregistered NEW cron is reported (cron #16 nobody added to the guard)", () => {
  const src = realSource();
  const anchor = `    ctx.waitUntil(
      runFreeOrgCapCron(env).catch((err: unknown) =>`;
  assert.ok(src.includes(anchor));
  const added = `    ctx.waitUntil(
      runBrandNewCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "brand new cron failed", error: String(err) })),
      ),
    );
`;
  const mutated = src.replace(anchor, added + anchor);
  const violations = dispatchViolations(analyseScheduledDispatch(mutated));
  assert.ok(
    violations.some((v) => v.includes("runBrandNewCron")),
    `expected an unexpected-cron violation, got: ${JSON.stringify(violations)}`,
  );
});
