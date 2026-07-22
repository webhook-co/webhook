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
  readRegisteredJobIds,
  readWranglerCrons,
  triggerViolations,
} from "./cron-dispatch-guard.mjs";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const engineSource = () => readFileSync(repoFile("apps/engine/src/index.ts"), "utf8");
const apiSource = () => readFileSync(repoFile("apps/api/src/index.ts"), "utf8");
const registry = () =>
  readRegisteredJobIds(readFileSync(repoFile("apps/health/src/heartbeat.ts"), "utf8"));

const analyseEngine = (src) => analyseScheduledDispatch(src, { hasCadenceGate: true });
const engineViolations = (src, ids = registry()) =>
  dispatchViolations(analyseEngine(src), ENGINE_CRONS, "apps/engine", ids);
const apiViolations = (src, ids = registry()) =>
  dispatchViolations(
    analyseScheduledDispatch(src, { hasCadenceGate: false }),
    API_CRONS,
    "apps/api",
    ids,
  );

// --- the guard running against PRODUCTION ---

test("every real committed target has zero violations", () => {
  assert.deepEqual(checkCronDispatch(), []);
});

test("the guard covers every worker that fans crons out of an inline scheduled()", () => {
  assert.deepEqual(TARGETS.map((t) => t.label).sort(), ["apps/api", "apps/engine"]);
});

test("the engine dispatches exactly 15 crons, 1 on the cap tick and 14 hourly", () => {
  assert.equal(Object.keys(ENGINE_CRONS).length, 15);
  assert.equal(CAP_TICK_CRONS.length, 1);
  assert.equal(HOURLY_ONLY_CRONS.length, 14);

  const found = analyseEngine(engineSource());
  assert.equal(found.units.length, 15);
  assert.equal(found.extraReturns, 0);
});

test("EVERY cron in every target reports a heartbeat that apps/health actually accepts", () => {
  // The property that makes a silently-dead cron detectable at all. An id the health worker does not
  // recognise is REJECTED, so the beat is dropped and the job reads as dead — a false alarm that trains
  // operators to ignore the dashboard, which is worse than no dashboard.
  const ids = registry();
  assert.ok(ids && ids.length >= 19, `expected a populated registry, got ${ids && ids.length}`);

  for (const [src, model, gate] of [
    [engineSource(), ENGINE_CRONS, true],
    [apiSource(), API_CRONS, false],
  ]) {
    const found = analyseScheduledDispatch(src, { hasCadenceGate: gate });
    for (const unit of found.units) {
      assert.equal(unit.beat, model[unit.cron].beat, `${unit.cron} reports the wrong heartbeat id`);
      assert.ok(
        ids.includes(unit.beat),
        `${unit.cron}'s heartbeat "${unit.beat}" is not registered`,
      );
      assert.equal(unit.envArg, true, `${unit.cron} is not called with env`);
      assert.equal(unit.gated, false, `${unit.cron} is conditionally dispatched`);
      assert.equal(unit.hasCatch, false, `${unit.cron} has a catch that would hide its failure`);
    }
  }
});

// --- fail-closed floors ---

test("FAIL-CLOSED: unparseable / empty source yields null, not an empty pass", () => {
  assert.equal(analyseEngine(""), null);
  assert.equal(analyseEngine("const x = 1;"), null);
});

test("FAIL-CLOSED: a null analysis is a violation, not a vacuous pass", () => {
  assert.match(dispatchViolations(null)[0], /could not read the scheduled\(\) dispatch/i);
});

test("FAIL-CLOSED: an analysis with no dispatched crons is a violation", () => {
  assert.ok(dispatchViolations({ units: [] }).length > 0);
});

test("FAIL-CLOSED: an unreadable job registry is a violation", () => {
  assert.equal(readRegisteredJobIds("nothing here"), null);
  assert.equal(readRegisteredJobIds("export const REGISTERED_JOBS = [\n];"), null);
  assert.equal(readRegisteredJobIds(42), null);
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
    /\n\s*ctx\.waitUntil\(withHeartbeat\(env, "org-reaper"[\s\S]*?\);/,
    "",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runOrgReaperDrainCron") && /never dispatched/i.test(v),
    ),
  );
});

test("MUTATION: dispatching a cron WITHOUT withHeartbeat is reported", () => {
  // The regression that matters most: the cron still runs, so every other check passes and the whole
  // suite stays green — but if it ever stops firing, nothing notices. That is the failure class this
  // lane exists to close.
  const mutated = engineSource().replace(
    'ctx.waitUntil(withHeartbeat(env, "anchor", () => runAuditAnchorCron(env)));',
    "ctx.waitUntil(runAuditAnchorCron(env));",
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runAuditAnchorCron") && /WITHOUT withHeartbeat/i.test(v),
    ),
  );
});

test("MUTATION: a TYPO'd heartbeat id is reported (the real job would read as dead)", () => {
  const mutated = engineSource().replace('"retention-prune"', '"retention-prunes"');
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runRetentionPruneDrainCron") && /heartbeat id/i.test(v),
    ),
  );
});

test("MUTATION: a heartbeat id missing from REGISTERED_JOBS is reported", () => {
  // Guard and source can agree with each other and still both be wrong about what apps/health accepts.
  const idsWithout = registry().filter((i) => i !== "orphan-sweep");
  assert.ok(
    engineViolations(engineSource(), idsWithout).some(
      (v) => v.includes("orphan-sweep") && /REGISTERED_JOBS/.test(v),
    ),
  );
});

test("MUTATION: a hand-attached .catch() around the wrapper is reported", () => {
  // Worse than no catch: it swallows the failure BEFORE withHeartbeat can grade it, so the job reports
  // healthy while broken — the precise false-healthy signal the dead-man's switch exists to prevent.
  const mutated = engineSource().replace(
    'ctx.waitUntil(withHeartbeat(env, "reconcile", () => runReconcilerCron(env)));',
    'ctx.waitUntil(withHeartbeat(env, "reconcile", () => runReconcilerCron(env)).catch(() => {}));',
  );
  assert.notEqual(mutated, engineSource(), "mutation did not apply");
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runReconcilerCron") && /HEALTHY while broken/i.test(v),
    ),
  );
});

test("MUTATION: handing a cron something other than env is reported", () => {
  const mutated = engineSource().replace(
    "() => runPayloadPurgeDrainCron(env)",
    "() => runPayloadPurgeDrainCron({} as Env)",
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
  const line =
    'ctx.waitUntil(withHeartbeat(env, "retention-prune", () => runRetentionPruneDrainCron(env)));';
  assert.ok(src.includes(line));
  const gate = "    if (!plan.runsHourly) return;";
  const mutated = src.replace(`    ${line}\n`, "").replace(gate, `    ${line}\n${gate}`);
  assert.ok(
    engineViolations(mutated).some(
      (v) => v.includes("runRetentionPruneDrainCron") && /every 5 minutes|cap tick/i.test(v),
    ),
  );
});

test("MUTATION: an unregistered NEW cron is reported (cron #16 nobody told the guard about)", () => {
  const src = engineSource();
  const anchor = 'ctx.waitUntil(withHeartbeat(env, "free-org-cap", () => runFreeOrgCapCron(env)));';
  assert.ok(src.includes(anchor));
  const added = 'ctx.waitUntil(withHeartbeat(env, "brand-new", () => runBrandNewCron(env)));\n    ';
  assert.ok(
    engineViolations(src.replace(anchor, added + anchor)).some((v) =>
      v.includes("runBrandNewCron"),
    ),
  );
});

test("MUTATION: wrapping a cron in an unrelated conditional is reported", () => {
  const src = engineSource();
  const line =
    'ctx.waitUntil(withHeartbeat(env, "orphan-sweep", () => runOrphanSweepDrainCron(env)));';
  assert.ok(src.includes(line));
  assert.ok(
    engineViolations(
      src.replace(line, `if (env.ORPHAN_SWEEP_DELETE) {\n      ${line}\n    }`),
    ).some((v) => v.includes("runOrphanSweepDrainCron") && /conditional|MAY NOT RUN/i.test(v)),
  );
});

test("MUTATION: disabling the cap gate with `if (false)` is reported", () => {
  const src = engineSource();
  assert.ok(src.includes("    if (plan.runsCap) {"));
  assert.ok(
    engineViolations(src.replace("    if (plan.runsCap) {", "    if (false) {")).some((v) =>
      v.includes("runCapProducerCron"),
    ),
  );
});

test("MUTATION: a SECOND early return after the cadence gate is reported", () => {
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
  assert.deepEqual(
    analyseEngine(engineSource())
      .units.filter((u) => u.gated)
      .map((u) => u.cron),
    [],
  );
});

test("an UNRELATED early return above the crons is not mistaken for the cadence gate", () => {
  const src = engineSource();
  const anchor = "    const plan = scheduledCronPlan(controller.cron);";
  assert.ok(src.includes(anchor));
  const found = analyseEngine(src.replace(anchor, `${anchor}\n    if (!env.KV_CONFIG) return;`));

  assert.deepEqual(
    found.units.filter((u) => u.cadence === "cap").map((u) => u.cron),
    CAP_TICK_CRONS,
  );
  assert.equal(found.units.length, 15);
  assert.equal(found.extraReturns, 1);
});

// --- apps/api ---

test("MUTATION: swapping one api cron for a duplicate of the other is reported", () => {
  const mutated = apiSource().replace(
    'withHeartbeat(env, "billing-cancellation", () => runBillingCancellationCron(env))',
    'withHeartbeat(env, "billing-cancellation", () => runRetentionReconcileCron(env))',
  );
  assert.notEqual(mutated, apiSource(), "mutation did not apply");
  const violations = apiViolations(mutated);
  assert.ok(
    violations.some((v) => v.includes("runBillingCancellationCron") && /never dispatched/i.test(v)),
  );
  assert.ok(violations.some((v) => /more than once/i.test(v)));
});

// --- cron triggers ---

test("the committed api/auth/health wrangler triggers match what their dispatches assume", () => {
  assert.deepEqual(triggerViolations(), []);
});

test("readWranglerCrons parses the real files, and fails CLOSED on anything it cannot read", () => {
  assert.deepEqual(readWranglerCrons(readFileSync(repoFile("apps/auth/wrangler.jsonc"), "utf8")), [
    "0 * * * *",
  ]);
  for (const bad of ["", "no crons here", '"crons": [', '"crons": []', 42]) {
    assert.equal(readWranglerCrons(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("MUTATION: retuning auth's trigger to daily is reported (the hour gate would never match)", () => {
  const violations = triggerViolations({ "apps/auth/wrangler.jsonc": ["0 * * * *"] }, () => [
    "0 0 * * *",
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /apps\/auth\/wrangler\.jsonc/);
});

test("FAIL-CLOSED: an unreadable wrangler triggers block is a violation", () => {
  const violations = triggerViolations({ "apps/api/wrangler.jsonc": ["0 * * * *"] }, () => null);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read triggers\.crons/);
});
