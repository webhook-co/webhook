#!/usr/bin/env node
/**
 * cron-dispatch-guard — the engine's scheduled() fan-out must dispatch EXACTLY the expected crons, each
 * isolated by its own `.catch()`, on the correct side of the `if (!plan.runsHourly) return;` early return.
 *
 * WHY THIS EXISTS. `scheduled()` (apps/engine/src/index.ts) fans out 15 crons via ctx.waitUntil. Deleting
 * one is invisible: no test failed, no error fires, the cron simply stops running in production forever.
 * apps/engine/test/scheduled-dispatch.test.ts covers the RUNTIME behaviour (how many units are dispatched,
 * that failures are absorbed, that the cap tick runs only the cap producer). It cannot, however, name the
 * crons it did not observe — a `waitUntil` promise is opaque, and 9 of the 15 are dark-launched no-ops that
 * emit nothing. This guard supplies the other half: IDENTITY, statically, by parsing the dispatch body.
 *
 * WHY AN AST, NOT A REGEX. A text scan over TypeScript is a latent lie — an arrow-function cron, an extra
 * parameter, or Prettier wrapping a long signature would silently make it dormant, and a dormant guard
 * reads exactly like a passing one. This parses with the TypeScript compiler API (already a devDependency,
 * and already used by scripts/tsconfig-boundary.mjs) and walks real nodes.
 *
 * WHY IDENTIFIERS, NOT LOG STRINGS. The guard keys on the FUNCTION IDENTIFIER (`runRetentionPruneDrainCron`),
 * never on the human name in the log line. Those two can desynchronise — and two crons deliberately throw so
 * that their `.catch()` emits the alarm (index.ts `runRetentionPruneDrainCron`, `runFreeOrgCapCron`), so a
 * mismatched pairing would page the wrong subsystem. Identifiers cannot drift from the function they call.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ENGINE_INDEX = fileURLToPath(new URL("../apps/engine/src/index.ts", import.meta.url));

/** Crons that run on EVERY tick, including the every-5-minutes cap trigger (above the early return).
 *  Adding to this list means accepting 12x the invocations — it is deliberately hard to do by accident. */
export const CAP_TICK_CRONS = ["runCapProducerCron"];

/** Crons gated behind `if (!plan.runsHourly) return;` — the heavy hourly jobs. */
export const HOURLY_ONLY_CRONS = [
  "runAuditAnchorCron",
  "runReconcilerCron",
  "runMeteringRollupCron",
  "runDeliveryStatsRollupCron",
  "runActivationRollupCron",
  "runMeterReporterCron",
  "runMeteringReconcileCron",
  "runMeterTransportReconcileCron",
  "runPayloadPurgeDrainCron",
  "runRetentionPruneDrainCron",
  "runOrgReaperDrainCron",
  "runOrphanSweepDrainCron",
  "runEventPayloadPurgeDrainCron",
  "runFreeOrgCapCron",
];

const isCronIdentifier = (name) => /^run[A-Za-z0-9]*Cron$/.test(name);

/** `ctx.waitUntil(...)` — a call whose callee is a property access named `waitUntil`. */
function isWaitUntilCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "waitUntil"
  );
}

/** The CronPlan flag whose early return separates the every-tick crons from the hourly-only ones. */
const CADENCE_GATE_FLAG = "runsHourly";

/** Whether an expression mentions `…runsHourly` anywhere within it. */
function mentionsCadenceFlag(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === CADENCE_GATE_FLAG) return true;
  if (ts.isIdentifier(node) && node.text === CADENCE_GATE_FLAG) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && mentionsCadenceFlag(child)) found = true;
  });
  return found;
}

/**
 * `if (!plan.runsHourly) return;` — an if whose then-branch is a bare `return;` AND whose condition
 * actually tests the cadence flag.
 *
 * The condition check is load-bearing, not belt-and-braces. Matching ANY bare `if (x) return;` would
 * mean an unrelated early return added above the fan-out (a new binding guard, say) became the boundary,
 * sweeping the cap producer below it and reporting a misplacement that isn't real. A guard that raises
 * false failures gets ignored and then deleted, so it must key on the specific gate it cares about.
 * If the flag is ever renamed no gate is found, `analyseScheduledDispatch` returns null, and the guard
 * fails CLOSED — which is the right outcome: renaming the cadence flag should require a look here.
 */
function isEarlyReturn(stmt) {
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

/** Descend a `runX(env).catch(...)` chain and report the cron identifier plus whether a catch is attached. */
function describeDispatchedUnit(arg) {
  let hasCatch = false;
  let node = arg;
  while (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch") {
      hasCatch = true;
      node = node.expression.expression;
      continue;
    }
    if (ts.isIdentifier(node.expression) && isCronIdentifier(node.expression.text)) {
      return { cron: node.expression.text, hasCatch };
    }
    // Some other call in the chain (e.g. `.then`) — keep unwrapping if we can.
    if (ts.isPropertyAccessExpression(node.expression)) {
      node = node.expression.expression;
      continue;
    }
    break;
  }
  return null;
}

function collectWaitUntilUnits(node, out) {
  if (isWaitUntilCall(node) && node.arguments.length === 1) {
    const unit = describeDispatchedUnit(node.arguments[0]);
    if (unit) out.push(unit);
    return;
  }
  ts.forEachChild(node, (child) => collectWaitUntilUnits(child, out));
}

/** Find the `scheduled(...)` method on the default-exported handler object. */
function findScheduledBody(sourceFile) {
  let body = null;
  const visit = (node) => {
    if (body) return;
    if (ts.isExportAssignment(node)) {
      let expr = node.expression;
      // `export default { ... } satisfies ExportedHandler<Env>` wraps the literal.
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
          if (ts.isMethodDeclaration(member) && member.body) body = member.body;
          else if (
            ts.isPropertyAssignment(member) &&
            (ts.isArrowFunction(member.initializer) ||
              ts.isFunctionExpression(member.initializer)) &&
            ts.isBlock(member.initializer.body)
          ) {
            body = member.initializer.body;
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
 * Parse the engine source and report which crons are dispatched on which side of the early return.
 * Returns null when the dispatch body cannot be read — callers MUST treat null as a violation.
 */
export function analyseScheduledDispatch(sourceText) {
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

  const capTick = [];
  const hourlyOnly = [];
  const missingCatch = [];
  let seenEarlyReturn = false;

  for (const stmt of body.statements) {
    if (isEarlyReturn(stmt)) {
      seenEarlyReturn = true;
      continue;
    }
    const units = [];
    collectWaitUntilUnits(stmt, units);
    for (const unit of units) {
      (seenEarlyReturn ? hourlyOnly : capTick).push(unit.cron);
      if (!unit.hasCatch) missingCatch.push(unit.cron);
    }
  }
  // No early return found at all ⇒ we cannot classify placement; fail closed.
  if (!seenEarlyReturn) return null;
  if (capTick.length === 0 && hourlyOnly.length === 0) return null;
  return { capTick, hourlyOnly, missingCatch };
}

/** Turn an analysis into human-readable violations. A null analysis is ALWAYS a violation. */
export function dispatchViolations(analysis) {
  if (analysis === null || typeof analysis !== "object") {
    return [
      "could not read the scheduled() dispatch from apps/engine/src/index.ts — the guard cannot verify the crons",
    ];
  }
  const { capTick, hourlyOnly, missingCatch } = analysis;
  if (!Array.isArray(capTick) || !Array.isArray(hourlyOnly) || !Array.isArray(missingCatch)) {
    return ["the scheduled() dispatch analysis is malformed — the guard cannot verify the crons"];
  }
  if (capTick.length === 0 && hourlyOnly.length === 0) {
    return ["scheduled() dispatches NO crons — the whole hourly fan-out would be dead"];
  }

  const violations = [];
  const dispatched = new Map();
  for (const cron of capTick) dispatched.set(cron, "cap");
  for (const cron of hourlyOnly) dispatched.set(cron, "hourly");

  for (const cron of CAP_TICK_CRONS) {
    const where = dispatched.get(cron);
    if (where === undefined) {
      violations.push(`${cron} is never dispatched by scheduled() — that cron would stop running`);
    } else if (where !== "cap") {
      violations.push(
        `${cron} is dispatched BELOW \`if (!plan.runsHourly) return;\` — it would stop running on the cap tick`,
      );
    }
  }
  for (const cron of HOURLY_ONLY_CRONS) {
    const where = dispatched.get(cron);
    if (where === undefined) {
      violations.push(`${cron} is never dispatched by scheduled() — that cron would stop running`);
    } else if (where !== "hourly") {
      violations.push(
        `${cron} is dispatched ABOVE \`if (!plan.runsHourly) return;\` — it would run on the cap tick, every 5 minutes (12x the hourly load)`,
      );
    }
  }
  const expected = new Set([...CAP_TICK_CRONS, ...HOURLY_ONLY_CRONS]);
  for (const cron of dispatched.keys()) {
    if (!expected.has(cron)) {
      violations.push(
        `${cron} is dispatched by scheduled() but is not listed in cron-dispatch-guard.mjs — add it to CAP_TICK_CRONS or HOURLY_ONLY_CRONS after confirming its cadence`,
      );
    }
  }
  for (const cron of missingCatch) {
    violations.push(
      `${cron} is dispatched without a \`.catch(...)\` — its failure would surface as an unhandled rejection instead of a named log line`,
    );
  }
  // Duplicate dispatch: the Map collapses repeats, so compare raw counts.
  const seen = new Set();
  for (const cron of [...capTick, ...hourlyOnly]) {
    if (seen.has(cron)) violations.push(`${cron} is dispatched more than once by scheduled()`);
    seen.add(cron);
  }
  return violations;
}

/** Read the committed engine source and check it. */
export function checkCronDispatch(indexPath = ENGINE_INDEX) {
  let source;
  try {
    source = readFileSync(indexPath, "utf8");
  } catch (err) {
    return [`could not read ${indexPath}: ${String(err)}`];
  }
  return dispatchViolations(analyseScheduledDispatch(source));
}

async function main() {
  const violations = checkCronDispatch();
  if (violations.length > 0) {
    console.error("cron-dispatch-guard: the engine's scheduled() fan-out drifted.\n");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nEvery cron must be dispatched exactly once, with its own .catch(), on the correct side of\n" +
        "`if (!plan.runsHourly) return;`. If you added or removed a cron deliberately, update\n" +
        "CAP_TICK_CRONS / HOURLY_ONLY_CRONS in scripts/cron-dispatch-guard.mjs.",
    );
    process.exit(1);
  }
  console.log(
    `cron-dispatch-guard: OK — ${CAP_TICK_CRONS.length + HOURLY_ONLY_CRONS.length} crons dispatched, each isolated, placement correct.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
