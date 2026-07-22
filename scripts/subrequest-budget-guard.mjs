#!/usr/bin/env node
/**
 * subrequest-budget-guard — the engine's hourly scheduled() invocation must fit inside the subrequest
 * ceiling declared in apps/engine/wrangler.jsonc.
 *
 * WHY THIS EXISTS. Fifteen crons share ONE invocation's subrequest budget. Every bound that feeds that
 * total is a plain numeric constant — `RETENTION_ORG_LIMIT`, `DEFAULT_METERING_ROLLUP_LIMIT`, and a dozen
 * more — and raising any one of them is a one-character edit that no test, type, or review step connects to
 * the ceiling. The ceiling itself was justified only in a prose comment, and that comment was WRONG twice:
 * it claimed "~9 crons" when there were 15, and its arithmetic counted the drains' multi-statement work
 * correctly while treating the per-org enumerations as one operation each.
 *
 * Prose cannot be wrong loudly. This can: the model below is evaluated against the constants as they
 * actually are, and CI fails when the total crosses the declared ceiling.
 *
 * WHAT THE FAILURE MODE IS. Exceeding the ceiling does not fail cleanly. `Too many subrequests` throws in
 * whichever cron happens to make the next call, so the victim is whichever units run LAST — unrelated to
 * whichever cron actually consumed the budget. Every engine cron swallows into a per-cron log line, so the
 * observable symptom is a quiet partial outage.
 *
 * WHAT THIS IS NOT. The per-unit `ops` factors are a documented ESTIMATE of how many round trips one unit
 * of work costs, read off the source. They are deliberately conservative. This guard's value is not
 * predicting the exact number — it is ensuring that when someone raises a limit, the arithmetic is redone
 * by a machine rather than assumed by a human.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/** Files whose top-level numeric constants feed the model. */
export const CONSTANT_SOURCES = [
  "apps/engine/src/index.ts",
  "packages/db/src/reconcile.ts",
  "packages/db/src/usage-rollup.ts",
  "packages/db/src/delivery-stats-rollup.ts",
  "packages/db/src/activation-rollup.ts",
  "packages/db/src/cap-producer.ts",
  "packages/db/src/meter-reporter.ts",
  "packages/db/src/meter-reconcile.ts",
  "packages/db/src/meter-transport-reconcile.ts",
];

/**
 * Worst-case subrequests per hourly invocation, per cron.
 *
 * `units` multiplies the named constants; `ops` is round trips per unit. Where a cron loops per org inside
 * a `withTenant` transaction, `ops` covers BEGIN + set_config + the statements + COMMIT — that is the term
 * the old prose comment omitted, and it dominates the total.
 */
export const BUDGET_MODEL = [
  // --- bounded drains: units are batches, ops are the statements per batch ---
  {
    cron: "retention prune",
    units: ["RETENTION_ORG_LIMIT", "RETENTION_BATCHES_PER_ORG"],
    ops: 3,
    note: "select expiring page + delete rows + delete R2 bodies",
  },
  {
    cron: "payload purge",
    units: ["PURGE_JOB_LIMIT", "PURGE_BATCHES_PER_JOB"],
    ops: 2,
    note: "R2 list + R2 delete per batch",
  },
  {
    cron: "org reaper",
    units: ["REAPER_ORG_LIMIT", "REAPER_CHUNKS_PER_ORG"],
    ops: 1,
    note: "one bounded delete per chunk",
  },
  {
    cron: "event payload purge",
    units: ["EVENT_PURGE_JOB_LIMIT"],
    ops: 2,
    note: "R2 delete + mark done per job",
  },
  {
    cron: "orphan sweep",
    units: [],
    ops: 4,
    note: "one R2 list page + anti-join + delete + cursor write",
  },
  { cron: "audit anchor", units: [], ops: 4, note: "cross-org head read + R2 anchor put" },

  // --- per-org enumerations: ops is a multi-statement transaction per org ---
  {
    cron: "delivery reconciler",
    units: ["DEFAULT_RECONCILE_LIMIT"],
    ops: 1,
    note: "one DO wake per due destination",
  },
  {
    cron: "metering rollup",
    units: ["DEFAULT_METERING_ROLLUP_LIMIT"],
    ops: 9,
    note: "withTenant tx per org: begin+set_config+tz+status+3x rollup_usage+update+commit",
  },
  {
    cron: "delivery stats rollup",
    units: ["DEFAULT_DELIVERY_STATS_ROLLUP_LIMIT"],
    ops: 6,
    note: "withTenant tx per org",
  },
  {
    cron: "activation rollup",
    units: ["DEFAULT_ACTIVATION_ROLLUP_LIMIT"],
    ops: 6,
    note: "withTenant tx per org",
  },
  {
    cron: "cap producer",
    units: ["DEFAULT_CAP_PRODUCER_LIMIT"],
    ops: 6,
    note: "withTenant tx per org (+ KV eviction on transition)",
  },
  {
    cron: "meter reporter",
    units: ["DEFAULT_METER_REPORTER_LIMIT"],
    ops: 9,
    note: "per org: read tx + Stripe call + finalize tx",
  },
  {
    cron: "meter reconcile",
    units: ["DEFAULT_METER_RECONCILE_LIMIT"],
    ops: 2,
    note: "recount + compare per finalized day",
  },
  {
    cron: "meter transport reconcile",
    units: ["DEFAULT_TRANSPORT_ORG_LIMIT"],
    ops: 2,
    note: "one Stripe summaries call per org (+ the bounded org page)",
  },
  {
    cron: "heartbeat reporting",
    units: [],
    ops: 15,
    note: "one POST to apps/health per engine cron — the dead-man's switch beat",
  },
  {
    cron: "free-org-cap",
    units: ["DEFAULT_CAP_PRODUCER_LIMIT"],
    ops: 4,
    note: "per-user flag/suspend/restore pass",
  },
];

/** Collect every top-level `const NAME = <number>` from a TS source. */
export function numericConstants(sourceText, fileLabel = "source") {
  if (typeof sourceText !== "string" || sourceText.trim() === "") return null;
  const sf = ts.createSourceFile(
    fileLabel,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isNumericLiteral(init)) found.set(node.name.text, Number(init.text));
      // `const X = 24 * 60 * 60 * 1000` style products of literals.
      else if (ts.isBinaryExpression(init)) {
        const value = evalNumeric(init);
        if (value !== null) found.set(node.name.text, value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Fold a binary expression of numeric literals; null when anything else appears. */
function evalNumeric(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return evalNumeric(node.expression);
  if (!ts.isBinaryExpression(node)) return null;
  const l = evalNumeric(node.left);
  const r = evalNumeric(node.right);
  if (l === null || r === null) return null;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken:
      return l * r;
    case ts.SyntaxKind.PlusToken:
      return l + r;
    case ts.SyntaxKind.MinusToken:
      return l - r;
    case ts.SyntaxKind.SlashToken:
      return r === 0 ? null : l / r;
    default:
      return null;
  }
}

/** Read `limits.subrequests` from a wrangler JSONC. Null when unreadable — callers treat that as a violation. */
export function readSubrequestCeiling(text) {
  if (typeof text !== "string") return null;
  const m = /"subrequests"\s*:\s*(\d+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Evaluate the model. Returns {total, rows} or {reason} when a referenced constant is missing. */
export function evaluateBudget(constants, model = BUDGET_MODEL) {
  if (!(constants instanceof Map) || constants.size === 0) return { reason: "no-constants" };
  const rows = [];
  let total = 0;
  for (const entry of model) {
    let units = 1;
    for (const name of entry.units) {
      const value = constants.get(name);
      // Fail CLOSED: a renamed or deleted constant must not silently drop a cron's contribution to zero.
      if (typeof value !== "number") return { reason: `missing-constant:${name}` };
      units *= value;
    }
    const subrequests = units * entry.ops;
    total += subrequests;
    rows.push({ cron: entry.cron, subrequests });
  }
  return { total, rows };
}

/**
 * How much room the ceiling must leave above the modelled worst case.
 *
 * "Under the ceiling" is not enough. The model's per-unit `ops` are estimates read off the source, and a
 * ceiling pinned to exactly the modelled total would turn any estimate that is slightly low into a silent
 * partial outage. It is also a RUNAWAY backstop: it should sit far enough above legitimate work that
 * crossing it means something is genuinely wrong, not that the product grew.
 */
export const REQUIRED_HEADROOM = 2;

export function budgetViolations(evaluated, ceiling) {
  if (evaluated?.reason === "no-constants") {
    return ["could not read any numeric constants — the guard cannot verify the subrequest budget"];
  }
  if (typeof evaluated?.reason === "string") {
    const name = evaluated.reason.split(":")[1];
    return [
      `the budget model references \`${name}\`, which no longer exists — rename it in ` +
        `scripts/subrequest-budget-guard.mjs (BUDGET_MODEL) and re-derive the total`,
    ];
  }
  if (typeof ceiling !== "number") {
    return ["could not read limits.subrequests from apps/engine/wrangler.jsonc"];
  }
  if (evaluated.total * REQUIRED_HEADROOM > ceiling) {
    const top = [...evaluated.rows].sort((a, b) => b.subrequests - a.subrequests).slice(0, 4);
    const verb = evaluated.total > ceiling ? "ABOVE" : `within ${REQUIRED_HEADROOM}x of`;
    return [
      `the hourly scheduled() worst case is ${evaluated.total.toLocaleString("en-US")} subrequests, ${verb} the ` +
        `declared ceiling of ${ceiling.toLocaleString("en-US")}. Largest contributors: ` +
        top.map((r) => `${r.cron} ${r.subrequests.toLocaleString("en-US")}`).join(", ") +
        `. Exceeding the ceiling does not fail cleanly — whichever cron makes the next call throws, so the ` +
        `victim is unrelated to the cause, and every engine cron swallows into a log line. The ceiling must ` +
        `leave ${REQUIRED_HEADROOM}x headroom (>= ${(evaluated.total * REQUIRED_HEADROOM).toLocaleString("en-US")}). ` +
        `Lower a bound, or raise limits.subrequests deliberately (paid plans allow up to 10,000,000).`,
    ];
  }
  return [];
}

export function checkSubrequestBudget(sources = CONSTANT_SOURCES) {
  const constants = new Map();
  for (const rel of sources) {
    let text;
    try {
      text = readFileSync(repoFile(rel), "utf8");
    } catch (err) {
      return [`could not read ${rel}: ${String(err)}`];
    }
    const found = numericConstants(text, rel);
    if (found === null)
      return [`could not parse ${rel} — the guard cannot verify the subrequest budget`];
    for (const [k, v] of found) if (!constants.has(k)) constants.set(k, v);
  }
  let wrangler;
  try {
    wrangler = readFileSync(repoFile("apps/engine/wrangler.jsonc"), "utf8");
  } catch (err) {
    return [`could not read apps/engine/wrangler.jsonc: ${String(err)}`];
  }
  return budgetViolations(evaluateBudget(constants), readSubrequestCeiling(wrangler));
}

async function main() {
  const violations = checkSubrequestBudget();
  if (violations.length > 0) {
    console.error("subrequest-budget-guard: the hourly cron fan-out no longer fits its ceiling.\n");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  const constants = new Map();
  for (const rel of CONSTANT_SOURCES) {
    for (const [k, v] of numericConstants(readFileSync(repoFile(rel), "utf8"), rel)) {
      if (!constants.has(k)) constants.set(k, v);
    }
  }
  const { total } = evaluateBudget(constants);
  const ceiling = readSubrequestCeiling(
    readFileSync(repoFile("apps/engine/wrangler.jsonc"), "utf8"),
  );
  console.log(
    `subrequest-budget-guard: OK — worst case ${total.toLocaleString("en-US")} of ${ceiling.toLocaleString("en-US")} ` +
      `(${Math.round((total / ceiling) * 100)}% of ceiling; ${REQUIRED_HEADROOM}x headroom required).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
