#!/usr/bin/env node
/**
 * cron-dispatch-guard — every Worker that fans crons out of `scheduled()` must dispatch EXACTLY the
 * expected set, unconditionally, with the expected failure handling, on the correct side of its cadence gate.
 *
 * WHY THIS EXISTS. A cron dropped from a `scheduled()` fan-out is invisible: no test fails, no error fires,
 * the cron simply stops running in production forever. The runtime tests
 * (apps/engine/test/scheduled-dispatch.test.ts, apps/api/src/scheduled-dispatch.test.ts) cover BEHAVIOUR —
 * how many units are dispatched, that the cap tick runs only the cap producer, that failures are absorbed.
 * They cannot cover IDENTITY: a `waitUntil` promise is opaque, and most of the engine's crons are
 * dark-launched no-ops that emit nothing whether or not they were wired up. This guard supplies identity,
 * statically, by parsing the dispatch body.
 *
 * WHAT IT PINS, and why each one is here rather than in a test:
 *   - the exact SET of cron identifiers, and which side of the cadence gate each sits on;
 *   - that each is dispatched UNCONDITIONALLY (a cron nested in an unrelated `if` still appears in the
 *     source but may never run);
 *   - that each receives `env` (passing `{}` instead is silent: dark crons no-op identically, and the
 *     runtime tests cannot see the argument);
 *   - that each carries a `.catch(...)` whose body logs the EXPECTED message — an empty `.catch(() => {})`
 *     or a renamed log line would otherwise pass every layer, and those strings are alert-matched;
 *   - that no early exit other than the cadence gate can short-circuit the crons below it.
 *
 * WHY AN AST, NOT A REGEX. A text scan over TypeScript is a latent lie — an arrow-function cron, an extra
 * parameter, or Prettier wrapping a long signature would silently make it dormant, and a dormant guard reads
 * exactly like a passing one. This parses with the TypeScript compiler API (already a devDependency, already
 * used by scripts/tsconfig-boundary.mjs) and walks real nodes.
 *
 * WHY IDENTIFIERS, NOT LOG STRINGS, FOR IDENTITY. The cron a unit runs is keyed on the FUNCTION IDENTIFIER,
 * never on the human name in its log line; the message is checked separately, against that identifier. The
 * two can desynchronise, and two engine crons deliberately throw so their `.catch()` emits the alarm
 * (runRetentionPruneDrainCron, runFreeOrgCapCron) — a mismatched pairing would page the wrong subsystem.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/** The CronPlan flag whose early return separates the every-tick crons from the hourly-only ones. */
const CADENCE_GATE_FLAG = "runsHourly";
/** Every CronPlan flag a dispatch may legitimately be gated on (the cap producer sits behind runsCap). */
const PLAN_FLAGS = ["runsCap", CADENCE_GATE_FLAG];

/**
 * The engine's crons: identifier -> { cadence, message }.
 *
 * `cadence: "cap"` means the cron runs on EVERY tick, including the every-5-minutes cap trigger — i.e. it
 * sits ABOVE the cadence gate. Moving a cron there means accepting 12x the invocations, so it is
 * deliberately hard to do by accident. `message` is the exact string its `.catch()` must log; these are
 * alert-matched, so changing one is an observability change, not a rename.
 */
export const ENGINE_CRONS = {
  runCapProducerCron: { cadence: "cap", message: "cap producer cron failed" },
  runAuditAnchorCron: { cadence: "hourly", message: "audit anchor cron failed" },
  runReconcilerCron: { cadence: "hourly", message: "delivery reconciler cron failed" },
  runMeteringRollupCron: { cadence: "hourly", message: "metering rollup cron failed" },
  runDeliveryStatsRollupCron: { cadence: "hourly", message: "delivery stats rollup cron failed" },
  runActivationRollupCron: { cadence: "hourly", message: "activation rollup cron failed" },
  runMeterReporterCron: { cadence: "hourly", message: "meter reporter cron failed" },
  runMeteringReconcileCron: { cadence: "hourly", message: "meter reconcile cron failed" },
  runMeterTransportReconcileCron: {
    cadence: "hourly",
    message: "meter transport reconcile cron failed",
  },
  runPayloadPurgeDrainCron: { cadence: "hourly", message: "payload purge cron failed" },
  runRetentionPruneDrainCron: { cadence: "hourly", message: "retention prune cron failed" },
  runOrgReaperDrainCron: { cadence: "hourly", message: "org reaper cron failed" },
  runOrphanSweepDrainCron: { cadence: "hourly", message: "orphan sweep cron failed" },
  runEventPayloadPurgeDrainCron: { cadence: "hourly", message: "event payload purge cron failed" },
  runFreeOrgCapCron: { cadence: "hourly", message: "free-org-cap cron failed" },
};

/**
 * apps/api's crons. Deliberately NO `.catch()` (message: null): each cron self-guards and returns cleanly
 * when billing is unprovisioned, and leaving them unwrapped means a regression still reaches the Cron
 * Trigger status (ADR-0130 decision 2). Wrapping them would silence that, so the guard asserts their
 * ABSENCE of a catch just as firmly as it asserts the engine's presence of one.
 */
export const API_CRONS = {
  runRetentionReconcileCron: { cadence: "always", message: null },
  runBillingCancellationCron: { cadence: "always", message: null },
};

/** Every worker whose scheduled() fan-out this guard checks. */
export const TARGETS = [
  {
    label: "apps/engine",
    path: repoFile("apps/engine/src/index.ts"),
    crons: ENGINE_CRONS,
    hasCadenceGate: true,
  },
  {
    label: "apps/api",
    path: repoFile("apps/api/src/index.ts"),
    crons: API_CRONS,
    hasCadenceGate: false,
  },
];

/** Back-compat views over ENGINE_CRONS, kept because they read well in the guard's own tests. */
export const CAP_TICK_CRONS = Object.keys(ENGINE_CRONS).filter(
  (c) => ENGINE_CRONS[c].cadence === "cap",
);
export const HOURLY_ONLY_CRONS = Object.keys(ENGINE_CRONS).filter(
  (c) => ENGINE_CRONS[c].cadence === "hourly",
);

const isCronIdentifier = (name) => /^run[A-Za-z0-9]*Cron$/.test(name);

/** `ctx.waitUntil(...)` — a call whose callee is a property access named `waitUntil`. */
function isWaitUntilCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "waitUntil"
  );
}

/** Whether an expression mentions any of `names` anywhere within it. */
function mentionsFlag(node, names) {
  if (ts.isPropertyAccessExpression(node) && names.includes(node.name.text)) return true;
  if (ts.isIdentifier(node) && names.includes(node.text)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && mentionsFlag(child, names)) found = true;
  });
  return found;
}

const mentionsCadenceFlag = (node) => mentionsFlag(node, [CADENCE_GATE_FLAG]);

/**
 * `if (!plan.runsHourly) return;` — an if whose then-branch is a bare `return;` AND whose condition tests
 * the cadence flag.
 *
 * The condition check is load-bearing. Matching ANY bare `if (x) return;` would mean an unrelated early
 * return added above the fan-out became the boundary, sweeping the cap producer below it and reporting a
 * misplacement that isn't real; a guard that raises false failures gets ignored and then deleted. If the
 * flag is renamed, no gate is found and the guard fails CLOSED with a message naming that specific cause.
 */
function isCadenceGate(stmt) {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
  const then = stmt.thenStatement;
  const inner = ts.isBlock(then)
    ? then.statements.length === 1
      ? then.statements[0]
      : null
    : then;
  if (inner === null || !ts.isReturnStatement(inner) || inner.expression !== undefined)
    return false;
  return mentionsCadenceFlag(stmt.expression);
}

/**
 * Whether a top-level statement can exit `scheduled()` early. A bare `return;`, or an `if`/block containing
 * one, ends the fan-out for every cron declared below it — and placement analysis alone cannot see that.
 */
function containsTopLevelExit(node) {
  if (ts.isReturnStatement(node)) return true;
  // Do not descend into nested functions — a `return` there exits the callback, not scheduled().
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return false;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsTopLevelExit(child)) found = true;
  });
  return found;
}

/** The first `message: "<literal>"` property assigned anywhere inside a node, or null. */
function loggedMessage(node) {
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "message" &&
    ts.isStringLiteral(node.initializer)
  ) {
    return node.initializer.text;
  }
  let found = null;
  ts.forEachChild(node, (child) => {
    if (found === null) found = loggedMessage(child);
  });
  return found;
}

/**
 * Describe one dispatched unit: which cron it runs, whether a `.catch()` is attached and what that catch
 * logs, and whether the cron was handed `env`.
 */
function describeDispatchedUnit(arg) {
  let hasCatch = false;
  let message = null;
  let node = arg;
  while (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch") {
      hasCatch = true;
      // The catch body is where the alert-matched line is emitted; an empty body logs nothing.
      if (node.arguments.length === 1) message = loggedMessage(node.arguments[0]);
      node = node.expression.expression;
      continue;
    }
    if (ts.isIdentifier(node.expression) && isCronIdentifier(node.expression.text)) {
      const [first] = node.arguments;
      const envArg = first !== undefined && ts.isIdentifier(first) && first.text === "env";
      return { cron: node.expression.text, hasCatch, message, envArg };
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      node = node.expression.expression;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Collect every `ctx.waitUntil(...)` unit beneath `node`, tracking whether it sits behind a conditional that
 * is NOT a CronPlan flag. A cron nested in an unrelated `if` still appears in the dispatch body, so a walk
 * that merely collected identifiers would report it present while in production it runs only when that
 * condition holds. The cap producer's own `if (plan.runsCap)` wrapper is legitimate.
 */
function collectWaitUntilUnits(node, out, gated = false) {
  if (isWaitUntilCall(node) && node.arguments.length === 1) {
    const unit = describeDispatchedUnit(node.arguments[0]);
    if (unit) out.push({ ...unit, gated });
    return;
  }
  if (ts.isIfStatement(node)) {
    const planGated = mentionsFlag(node.expression, PLAN_FLAGS);
    collectWaitUntilUnits(node.expression, out, gated);
    collectWaitUntilUnits(node.thenStatement, out, gated || !planGated);
    if (node.elseStatement) collectWaitUntilUnits(node.elseStatement, out, gated || !planGated);
    return;
  }
  if (
    ts.isTryStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isConditionalExpression(node)
  ) {
    ts.forEachChild(node, (child) => collectWaitUntilUnits(child, out, true));
    return;
  }
  ts.forEachChild(node, (child) => collectWaitUntilUnits(child, out, gated));
}

/**
 * Find the `scheduled(...)` method on the default-exported handler object.
 *
 * NB this requires the fan-out to be INLINE in the handler. If a worker is ever refactored the way
 * apps/auth was — `scheduled: (e, env, ctx) => dispatchSomething(...)` — no dispatch is found here and the
 * guard fails closed; that worker then needs module-level tests instead, not an entry in TARGETS.
 */
function findScheduledBody(sourceFile) {
  let body = null;
  const visit = (node) => {
    if (body) return;
    if (ts.isExportAssignment(node)) {
      let expr = node.expression;
      while (
        ts.isSatisfiesExpression?.(expr) ||
        ts.isAsExpression(expr) ||
        ts.isParenthesizedExpression(expr)
      ) {
        expr = expr.expression;
      }
      if (ts.isObjectLiteralExpression(expr)) {
        for (const member of expr.properties) {
          const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
          if (name !== "scheduled") continue;
          if (ts.isMethodDeclaration(member) && member.body) {
            body = member.body;
            break;
          }
          if (
            ts.isPropertyAssignment(member) &&
            (ts.isArrowFunction(member.initializer) ||
              ts.isFunctionExpression(member.initializer)) &&
            ts.isBlock(member.initializer.body)
          ) {
            body = member.initializer.body;
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

/**
 * Parse a worker's source and report every dispatched unit plus the structure around it. Returns `null`, or
 * an object carrying a `reason`, when the dispatch cannot be read — callers MUST treat both as violations.
 */
export function analyseScheduledDispatch(sourceText, { hasCadenceGate = true } = {}) {
  if (typeof sourceText !== "string" || sourceText.trim() === "") return null;
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const body = findScheduledBody(sourceFile);
  if (!body) return null;

  const units = [];
  let extraReturns = 0;
  let seenCadenceGate = false;

  for (const stmt of body.statements) {
    if (hasCadenceGate && isCadenceGate(stmt)) {
      seenCadenceGate = true;
      continue;
    }
    if (containsTopLevelExit(stmt)) extraReturns += 1;

    const found = [];
    collectWaitUntilUnits(stmt, found);
    for (const unit of found) {
      units.push({
        ...unit,
        cadence: hasCadenceGate ? (seenCadenceGate ? "hourly" : "cap") : "always",
      });
    }
  }
  // Distinguished from "no scheduled body" so a renamed flag does not read as a parse bug.
  if (hasCadenceGate && !seenCadenceGate) return { reason: "no-cadence-gate" };
  if (units.length === 0) return null;
  return { units, extraReturns };
}

/** Turn an analysis into human-readable violations. A null or reason-carrying analysis is ALWAYS one. */
export function dispatchViolations(analysis, expected = ENGINE_CRONS, label = "apps/engine") {
  if (analysis === null || typeof analysis !== "object") {
    return [
      `could not read the scheduled() dispatch from ${label} — the guard cannot verify the crons`,
    ];
  }
  if (analysis.reason === "no-cadence-gate") {
    return [
      `the cadence gate \`if (!plan.runsHourly) return;\` was not found in ${label}'s scheduled() — if the ` +
        `CronPlan flag was renamed, update CADENCE_GATE_FLAG in scripts/cron-dispatch-guard.mjs`,
    ];
  }
  const { units, extraReturns } = analysis;
  if (!Array.isArray(units)) {
    return [`the ${label} dispatch analysis is malformed — the guard cannot verify the crons`];
  }
  if (units.length === 0) {
    return [`${label} scheduled() dispatches NO crons — the whole fan-out would be dead`];
  }

  const violations = [];
  const byCron = new Map();
  for (const unit of units) {
    if (byCron.has(unit.cron)) {
      violations.push(`${unit.cron} is dispatched more than once by ${label} scheduled()`);
    } else {
      byCron.set(unit.cron, unit);
    }
  }

  for (const [cron, want] of Object.entries(expected)) {
    const unit = byCron.get(cron);
    if (unit === undefined) {
      violations.push(
        `${cron} is never dispatched by ${label} scheduled() — that cron would stop running`,
      );
      continue;
    }
    if (unit.cadence !== want.cadence) {
      violations.push(
        want.cadence === "hourly"
          ? `${cron} is dispatched ABOVE \`if (!plan.runsHourly) return;\` — it would run on the cap tick, every 5 minutes (12x the hourly load)`
          : `${cron} is dispatched BELOW \`if (!plan.runsHourly) return;\` — it would stop running on the cap tick`,
      );
    }
    if (unit.gated) {
      violations.push(
        `${cron} is dispatched inside a conditional that is not a CronPlan flag — it MAY NOT RUN. A cron must be dispatched unconditionally on its side of the cadence gate.`,
      );
    }
    if (!unit.envArg) {
      violations.push(
        `${cron} is not called with \`env\` — a cron handed anything else silently no-ops (a dark cron behaves identically either way, so no test can see this)`,
      );
    }
    if (want.message === null) {
      if (unit.hasCatch) {
        violations.push(
          `${cron} has a \`.catch(...)\`, but ${label} deliberately leaves its crons unwrapped so a failure still reaches the Cron Trigger status (ADR-0130). Remove it, or update the guard if the policy changed.`,
        );
      }
      continue;
    }
    if (!unit.hasCatch) {
      violations.push(
        `${cron} is dispatched without a \`.catch(...)\` — its failure would surface as an unhandled rejection instead of a named log line`,
      );
    } else if (unit.message !== want.message) {
      violations.push(
        `${cron}'s .catch() logs ${unit.message === null ? "NOTHING" : `"${unit.message}"`}, expected "${want.message}" — these strings are alert-matched, and an empty or renamed catch body is a silent loss of the only failure signal this cron has`,
      );
    }
  }

  for (const cron of byCron.keys()) {
    if (!(cron in expected)) {
      violations.push(
        `${cron} is dispatched by ${label} scheduled() but is not listed in scripts/cron-dispatch-guard.mjs — add it after confirming its cadence and failure handling`,
      );
    }
  }

  if ((extraReturns ?? 0) > 0) {
    violations.push(
      `${label} scheduled() has ${extraReturns} early exit(s) besides the cadence gate — each one short-circuits EVERY cron declared below it, and placement analysis alone cannot see that. Guard the individual cron instead of returning from the fan-out.`,
    );
  }
  return violations;
}

/**
 * The cron TRIGGERS each non-engine worker must declare.
 *
 * apps/engine's triggers are already pinned by scripts/cap-cron-sync-guard.mjs against the constants in its
 * source. Nothing pinned the other two — and apps/auth's whole design depends on its trigger: the daily
 * cross-org expiry sweep (ADR-0055) runs behind an hour gate on an HOURLY trigger, so changing that trigger
 * to, say, "0 0 * * *" would mean the gate never matches and the sweep never runs again. No test, no error.
 */
export const EXPECTED_TRIGGERS = {
  "apps/api/wrangler.jsonc": ["0 * * * *"],
  "apps/auth/wrangler.jsonc": ["0 * * * *"],
};

/**
 * Read `triggers.crons` from a wrangler JSONC file. Isolates just the array literal, strips comments and a
 * trailing comma, then genuinely JSON.parses it — cron strings contain no `//` and no `]`, so the local
 * strip is safe. Returns null when it cannot be read, which callers MUST treat as a violation.
 */
export function readWranglerCrons(text) {
  if (typeof text !== "string") return null;
  const match = /"crons"\s*:\s*(\[[\s\S]*?\])/.exec(text);
  if (!match) return null;
  const literal = match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/,\s*\]$/, "]");
  try {
    const parsed = JSON.parse(literal);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((c) => typeof c === "string")) return null;
    return parsed.map((c) => c.trim().replace(/\s+/g, " "));
  } catch {
    return null;
  }
}

/** Compare each non-engine worker's declared triggers against what its dispatch assumes. */
export function triggerViolations(expected = EXPECTED_TRIGGERS, read = defaultReadTriggers) {
  const violations = [];
  for (const [rel, want] of Object.entries(expected)) {
    const found = read(rel);
    if (found === null) {
      violations.push(
        `could not read triggers.crons from ${rel} — the guard cannot verify the cadence`,
      );
      continue;
    }
    const wantNormalised = want.map((c) => c.trim().replace(/\s+/g, " "));
    if (found.length !== wantNormalised.length || found.some((c, i) => c !== wantNormalised[i])) {
      violations.push(
        `${rel} declares triggers.crons ${JSON.stringify(found)}, expected ${JSON.stringify(wantNormalised)} — ` +
          `the scheduled() dispatch is written against that cadence, so changing it here silently changes ` +
          `which crons run (update EXPECTED_TRIGGERS if the change is deliberate)`,
      );
    }
  }
  return violations;
}

function defaultReadTriggers(rel) {
  try {
    return readWranglerCrons(readFileSync(repoFile(rel), "utf8"));
  } catch {
    return null;
  }
}

/** Check one target. */
export function checkTarget(target) {
  let source;
  try {
    source = readFileSync(target.path, "utf8");
  } catch (err) {
    return [`could not read ${target.label}: ${String(err)}`];
  }
  const analysis = analyseScheduledDispatch(source, { hasCadenceGate: target.hasCadenceGate });
  return dispatchViolations(analysis, target.crons, target.label);
}

/** Check every target, plus the cron triggers the non-engine dispatches are written against. */
export function checkCronDispatch(targets = TARGETS) {
  return [...targets.flatMap((target) => checkTarget(target)), ...triggerViolations()];
}

async function main() {
  const violations = checkCronDispatch();
  if (violations.length > 0) {
    console.error("cron-dispatch-guard: a scheduled() fan-out drifted.\n");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nEvery cron must be dispatched exactly once, unconditionally, with `env`, with the expected\n" +
        "failure handling, on the correct side of the cadence gate. If you added or removed a cron\n" +
        "deliberately, update ENGINE_CRONS / API_CRONS in scripts/cron-dispatch-guard.mjs.",
    );
    process.exit(1);
  }
  // Print what was actually PARSED, not the expectation restated — otherwise the success line is not evidence.
  for (const target of TARGETS) {
    const source = readFileSync(target.path, "utf8");
    const analysis = analyseScheduledDispatch(source, { hasCadenceGate: target.hasCadenceGate });
    console.log(
      `cron-dispatch-guard: ${target.label} — ${analysis.units.length} crons dispatched, OK.`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
