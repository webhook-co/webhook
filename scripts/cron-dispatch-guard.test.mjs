import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  API_CRONS,
  CAP_TICK_CRONS,
  ENGINE_CRONS,
  HOURLY_ONLY_CRONS,
  TARGETS,
  analyseScheduledDispatch,
  checkCronDispatch,
  dispatchViolations,
  readWranglerCrons,
  triggerViolations,
} from "./cron-dispatch-guard.mjs";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const ENGINE_INDEX = repoFile("apps/engine/src/index.ts");
const API_INDEX = repoFile("apps/api/src/index.ts");

const engineSource = () => readFileSync(ENGINE_INDEX, "utf8");
const apiSource = () => readFileSync(API_INDEX, "utf8");

const analyseEngine = (src) => analyseScheduledDispatch(src, { hasCadenceGate: true });
const engineViolations = (src) =>
  dispatchViolations(analyseEngine(src), ENGINE_CRONS, "apps/engine");
const apiViolations = (src) =>
  dispatchViolations(
    analyseScheduledDispatch(src, { hasCadenceGate: false }),
    API_CRONS,
    "apps/api",
  );

// --- the guard running against PRODUCTION: the committed sources must satisfy it ---

test("every real committed target has zero violations", () => {
  assert.deepEqual(checkCronDispatch(), []);
});

test("the guard covers every worker that fans crons out of an inline scheduled()", () => {
  assert.deepEqual(TARGETS.map((t) => t.label).sort(), ["apps/api", "apps/engine"]);
});

test("the engine dispatches exactly 15 crons, 1 on the cap tick and 14 hourly", () => {
  // The literal 15 is pinned HERE as well as in apps/engine/test/scheduled-dispatch.test.ts, because
  // apps/engine/wrangler.jsonc and ADR-0130 both now assert that number in prose. Without it, deleting a
  // cron from both index.ts and ENGINE_CRONS would leave this suite green and only redden the engine's.
  assert.equal(Object.keys(ENGINE_CRONS).length, 15);
  assert.equal(CAP_TICK_CRONS.length, 1);
  assert.equal(HOURLY_ONLY_CRONS.length, 14);

  const found = analyseEngine(engineSource());
  assert.notEqual(found, null);
  assert.equal(found.units.length, 15);
  assert.deepEqual(
    found.units.filter((u) => u.cadence === "cap").map((u) => u.cron),
    CAP_TICK_CRONS,
  );
  assert.deepEqual(
    found.units
      .filter((u) => u.cadence === "hourly")
      .map((u) => u.cron)
      .sort(),
    [...HOURLY_ONLY_CRONS].sort(),
  );
  assert.equal(found.extraReturns, 0);
});

test("every engine cron is dispatched unconditionally, with env, and logs its alert-matched message", () => {
  const found = analyseEngine(engineSource());
  for (const unit of found.units) {
    assert.equal(unit.gated, false, `${unit.cron} is conditionally dispatched`);
    assert.equal(unit.envArg, true, `${unit.cron} is not called with env`);
    assert.equal(
      unit.message,
      ENGINE_CRONS[unit.cron].message,
      `${unit.cron} logs the wrong message`,
    );
  }
});

test("apps/api dispatches exactly its two billing crons, with env and deliberately NO catch", () => {
  const found = analyseScheduledDispatch(apiSource(), { hasCadenceGate: false });
  assert.notEqual(found, null);
  assert.deepEqual(found.units.map((u) => u.cron).sort(), Object.keys(API_CRONS).sort());
  for (const unit of found.units) {
    assert.equal(unit.envArg, true);
    assert.equal(unit.hasCatch, false, `${unit.cron} must stay unwrapped (ADR-0130 decision 2)`);
  }
});

// --- fail-closed floors: a guard that cannot read its input must NEVER report success ---

test("FAIL-CLOSED: unparseable / empty source yields null, not an empty pass", () => {
  assert.equal(analyseEngine(""), null);
  assert.equal(analyseEngine("const x = 1;"), null);
});

test("FAIL-CLOSED: a null analysis is a violation, not a vacuous pass", () => {
  const violations = dispatchViolations(null);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read the scheduled\(\) dispatch/i);
});

test("FAIL-CLOSED: an analysis with no dispatched crons is a violation", () => {
  assert.ok(dispatchViolations({ units: [] }).length > 0);
});

test("a RENAMED cadence flag reports that specifically, not a generic parse failure", () => {
  const violations = engineViolations(engineSource().replaceAll("runsHourly", "runsHeavy"));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /cadence gate/i);
  assert.match(violations[0], /CADENCE_GATE_FLAG/);
});

// --- real source mutations ---

test("MUTATION: deleting a waitUntil block is reported as a missing cron", () => {
  const mutated = engineSource().replace(
    /\n\s*ctx\.waitUntil\(\n\s*runOrgReaperDrainCron\(env\)[\s\S]*?\n\s*\);/,
    "",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runOrgReaperDrainCron") && /never dispatched/i.test(v),
    ),
  );
});

test("MUTATION: dropping a .catch() is reported", () => {
  const mutated = engineSource().replace(
    `ctx.waitUntil(
      runAuditAnchorCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "audit anchor cron failed", error: String(err) })),
      ),
    );`,
    "ctx.waitUntil(runAuditAnchorCron(env));",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some((v) => v.includes("runAuditAnchorCron") && /catch/i.test(v)),
  );
});

test("MUTATION: EMPTYING a .catch() body is reported — the catch survives, the alert does not", () => {
  // The likelier regression than deleting the catch outright: it still exists, so a presence-only check
  // passes, while the cron's only failure signal is gone. Nine of the fifteen crons are dark no-ops that
  // emit nothing anyway, so no runtime test can see this.
  const mutated = engineSource().replace(
    `runOrphanSweepDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "orphan sweep cron failed", error: String(err) })),
      )`,
    "runOrphanSweepDrainCron(env).catch(() => {})",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runOrphanSweepDrainCron") && /NOTHING|alert-matched/i.test(v),
    ),
  );
});

test("MUTATION: RENAMING an alert-matched log message is reported", () => {
  const mutated = engineSource().replace(
    '"retention prune cron failed"',
    '"retention cron failed"',
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runRetentionPruneDrainCron") && /alert-matched/i.test(v),
    ),
  );
});

test("MUTATION: handing a cron something other than env is reported", () => {
  // Silent in production and invisible to every runtime test: a dark cron no-ops identically, and an
  // unguarded one throws identically. Only the argument itself distinguishes them.
  const mutated = engineSource().replace(
    "runPayloadPurgeDrainCron(env)",
    "runPayloadPurgeDrainCron({} as Env)",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runPayloadPurgeDrainCron") && /not called with/i.test(v),
    ),
  );
});

test("MUTATION: promoting an hourly cron above the cadence gate is reported (the 12x bug)", () => {
  const src = engineSource();
  const block = `    ctx.waitUntil(
      runRetentionPruneDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "retention prune cron failed", error: String(err) })),
      ),
    );`;
  assert.ok(src.includes(block));
  const anchor = `    if (!plan.runsHourly) return;`;
  const mutated = src.replace(block + "\n", "").replace(anchor, block + "\n" + anchor);
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runRetentionPruneDrainCron") && /every 5 minutes|cap tick/i.test(v),
    ),
  );
});

test("MUTATION: an unregistered NEW cron is reported (cron #16 nobody added to the guard)", () => {
  const src = engineSource();
  const anchor = `    ctx.waitUntil(
      runFreeOrgCapCron(env).catch((err: unknown) =>`;
  assert.ok(src.includes(anchor));
  const added = `    ctx.waitUntil(
      runBrandNewCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "brand new cron failed", error: String(err) })),
      ),
    );
`;
  assert.ok(
    engineViolations(src.replace(anchor, added + anchor)).some((v) =>
      v.includes("runBrandNewCron"),
    ),
  );
});

test("MUTATION: wrapping a cron in an unrelated conditional is reported (it would silently not run)", () => {
  const src = engineSource();
  const block = `    ctx.waitUntil(
      runOrphanSweepDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "orphan sweep cron failed", error: String(err) })),
      ),
    );`;
  assert.ok(src.includes(block));
  const wrapped = `    if (env.ORPHAN_SWEEP_DELETE) {\n${block}\n    }`;
  assert.ok(
    engineViolations(src.replace(block, wrapped)).some(
      (v) => v.includes("runOrphanSweepDrainCron") && /conditional|MAY NOT RUN/i.test(v),
    ),
  );
});

test("MUTATION: disabling the cap gate with `if (false)` is reported", () => {
  // Silently stops the soft-cap producer — the fail-OPEN-to-unbilled-ingest outcome scheduledCronPlan
  // exists to prevent.
  const src = engineSource();
  assert.ok(src.includes("    if (plan.runsCap) {"));
  assert.ok(
    engineViolations(src.replace("    if (plan.runsCap) {", "    if (false) {")).some((v) =>
      v.includes("runCapProducerCron"),
    ),
  );
});

test("MUTATION: a SECOND early return after the cadence gate is reported (it kills every cron below it)", () => {
  const src = engineSource();
  const gate = "    if (!plan.runsHourly) return;";
  assert.ok(src.includes(gate));
  assert.ok(
    engineViolations(src.replace(gate, `${gate}\n    if (!env.HYPERDRIVE_ANCHOR) return;`)).some(
      (v) => /early exit/i.test(v),
    ),
  );
});

test("the cap producer's own `if (plan.runsCap)` wrapper is NOT reported as a conditional", () => {
  const found = analyseEngine(engineSource());
  assert.deepEqual(
    found.units.filter((u) => u.gated).map((u) => u.cron),
    [],
  );
});

test("an UNRELATED early return above the crons is not mistaken for the cadence gate", () => {
  // A guard that matched ANY bare `if (x) return;` would treat this as the boundary and misclassify the
  // cap producer. It must still be REPORTED (it short-circuits the fan-out) but for the right reason.
  const src = engineSource();
  const anchor = "    const plan = scheduledCronPlan(controller.cron);";
  assert.ok(src.includes(anchor));
  const found = analyseEngine(src.replace(anchor, `${anchor}\n    if (!env.KV_CONFIG) return;`));

  assert.notEqual(found, null);
  assert.deepEqual(
    found.units.filter((u) => u.cadence === "cap").map((u) => u.cron),
    CAP_TICK_CRONS,
  );
  assert.equal(found.units.length, 15);
  assert.equal(found.extraReturns, 1);
});

// --- apps/api ---

test("MUTATION: swapping one api cron for a duplicate of the other is reported", () => {
  // The delete-and-duplicate case a count assertion cannot see. Real consequence: an org hard-deleted
  // while paying never has its Stripe subscription cancelled — indefinite real-money charges, no error.
  const mutated = apiSource().replace(
    "ctx.waitUntil(runBillingCancellationCron(env));",
    "ctx.waitUntil(runRetentionReconcileCron(env));",
  );
  assert.notEqual(mutated, apiSource(), "mutation did not apply");
  const violations = apiViolations(mutated);
  assert.ok(
    violations.some((v) => v.includes("runBillingCancellationCron") && /never dispatched/i.test(v)),
  );
  assert.ok(violations.some((v) => /more than once/i.test(v)));
});

test("MUTATION: wrapping an api cron in a swallowing .catch() is reported", () => {
  // apps/api deliberately leaves its crons unwrapped so a regression reaches the Cron Trigger status
  // (ADR-0130 decision 2). That decision was documented but nothing enforced it.
  const mutated = apiSource().replace(
    "ctx.waitUntil(runRetentionReconcileCron(env));",
    "ctx.waitUntil(runRetentionReconcileCron(env).catch(() => {}));",
  );
  assert.notEqual(mutated, apiSource(), "mutation did not apply");
  assert.ok(
    apiViolations(mutated).some(
      (v) => v.includes("runRetentionReconcileCron") && /deliberately leaves/i.test(v),
    ),
  );
});

// --- cron triggers the dispatches are written against ---

test("the committed api/auth wrangler triggers match what their dispatches assume", () => {
  assert.deepEqual(triggerViolations(), []);
});

test("readWranglerCrons parses the real files, and fails CLOSED on anything it cannot read", () => {
  assert.deepEqual(readWranglerCrons(readFileSync(repoFile("apps/auth/wrangler.jsonc"), "utf8")), [
    "0 * * * *",
  ]);
  for (const bad of [
    "",
    "no crons here",
    '"crons": [',
    '"crons": ["unterminated',
    '"crons": []',
    42,
  ]) {
    assert.equal(readWranglerCrons(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("MUTATION: retuning auth's trigger to daily is reported (the hour gate would never match)", () => {
  // apps/auth runs a DAILY job behind an hour gate on an HOURLY trigger. Change the trigger to daily and
  // the gate never matches: the ADR-0055 cross-org expiry sweep never runs again, silently.
  const violations = triggerViolations({ "apps/auth/wrangler.jsonc": ["0 * * * *"] }, () => [
    "0 0 * * *",
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /apps\/auth\/wrangler\.jsonc/);
  assert.match(violations[0], /0 0 \* \* \*/);
});

test("FAIL-CLOSED: an unreadable wrangler triggers block is a violation", () => {
  const violations = triggerViolations({ "apps/api/wrangler.jsonc": ["0 * * * *"] }, () => null);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read triggers\.crons/);
});

test("MUTATION: handing an api cron something other than env is reported", () => {
  const mutated = apiSource().replace(
    "ctx.waitUntil(runRetentionReconcileCron(env));",
    "ctx.waitUntil(runRetentionReconcileCron({} as Env));",
  );
  assert.notEqual(mutated, apiSource(), "mutation did not apply");
  assert.ok(
    apiViolations(mutated).some(
      (v) => v.includes("runRetentionReconcileCron") && /not called with/i.test(v),
    ),
  );
});
