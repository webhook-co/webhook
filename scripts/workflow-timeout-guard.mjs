#!/usr/bin/env node
// Every GitHub Actions job must declare a runtime cap, and every failure gate must survive one.
//
// `grep -rn "timeout-minutes" .github/workflows/` used to return ZERO, so every job ran under
// GitHub's 360-minute default. The nightly-rls suite has reached ~4h and trends upward, so a runaway
// could burn most of a working day before anything stopped it.
//
// The second rule is the one that makes the first one safe, and it is not obvious:
//
//   A JOB-LEVEL TIMEOUT **CANCELS** THE JOB — IT DOES NOT FAIL IT.
//
// `failure()` is FALSE for a cancelled job. So adding a cap to `rls-neon` without widening
// `open-issue-on-failure`'s `if: failure()` gate would have converted "the nightly ran away and
// eventually stopped" into "the nightly reported nothing at all" — strictly worse than the runaway,
// because the whole point of that job is to be the channel we trust. Both rules therefore live in
// one guard: you cannot add the cap here and forget the gate.
//
// PARSES the YAML (via `yaml`) rather than text-scanning. A regex would be satisfied by the string
// `timeout-minutes` appearing in a comment or inside a `run:` block — a latent lie, and the exact
// failure mode this repo has already been bitten by in other guards.
//
// FAIL CLOSED: no workflow files, an unparseable file, or a workflow with no jobs is itself a
// violation — we cannot prove the caps are in place, so we block.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".github/workflows");

/**
 * A cap must be BELOW GitHub's default, or it buys nothing. 360 is the platform default; anything
 * at or above it is indistinguishable from having no cap.
 */
export const MAX_TIMEOUT_MINUTES = 360;

/** `if:` shapes that gate on a dependency having FAILED. Each is blind to `cancelled`. */
const FAILURE_GATE = /\bfailure\s*\(\s*\)|\.result\s*[=!]=\s*['"]failure['"]/;
/** …and the token that proves the gate was widened to see a timeout-cancelled dependency. */
const SEES_CANCELLED = /cancell?ed/i;

/**
 * The pure decision.
 * @param {{file: string, doc: unknown, error: string | null}[]} workflows
 * @returns {string[]} one human-readable violation per offending job
 */
export function workflowTimeoutViolations(workflows) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    return [
      "workflow-timeout-guard: no workflow files were read from .github/workflows — cannot prove " +
        "any job is capped. (A glob that matches nothing reads as clean; that is the bug.)",
    ];
  }

  const violations = [];
  for (const { file, doc, error } of workflows) {
    if (error || doc === null || typeof doc !== "object") {
      violations.push(
        `${file}: could not be parsed as YAML (${error ?? "no document"}), so its jobs cannot be checked.`,
      );
      continue;
    }
    const jobs = doc.jobs;
    if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0) {
      violations.push(`${file}: declares no jobs. Every workflow this guard reads must have some.`);
      continue;
    }

    for (const [id, job] of Object.entries(jobs)) {
      const cap = job?.["timeout-minutes"];
      if (!Number.isInteger(cap) || cap <= 0) {
        violations.push(
          `${file}: job \`${id}\` declares no \`timeout-minutes\`, so it runs under GitHub's ` +
            `${MAX_TIMEOUT_MINUTES}-minute default. Set a cap sized to what the job actually does.`,
        );
      } else if (cap >= MAX_TIMEOUT_MINUTES) {
        violations.push(
          `${file}: job \`${id}\` sets timeout-minutes: ${cap}, which is at or above GitHub's ` +
            `${MAX_TIMEOUT_MINUTES}-minute default — the same as having no cap at all.`,
        );
      }

      // The pairing rule. Checked for EVERY failure-gated job, not only ones whose dependency
      // happens to be capped today: once the rule above lands, every dependency can be cancelled.
      const gate = typeof job?.if === "string" ? job.if : "";
      if (FAILURE_GATE.test(gate) && !SEES_CANCELLED.test(gate)) {
        violations.push(
          `${file}: job \`${id}\` is gated on a dependency FAILING (\`if: ${gate.trim()}\`) but never ` +
            `mentions \`cancelled\`. A job-level timeout CANCELS the job it bounds, and \`failure()\` is ` +
            `FALSE for a cancelled job — so a runaway that hits its cap would silently report NOTHING. ` +
            `Widen the gate, e.g. ` +
            `\`if: \${{ always() && (needs.X.result == 'failure' || needs.X.result == 'cancelled') }}\`.`,
        );
      }
    }
  }
  return violations;
}

/** Read + parse every workflow. A parse error is captured, never thrown, so the rule can report it.
 *  @returns {Promise<{file: string, doc: unknown, error: string | null}[]>} */
export async function readWorkflows() {
  let names;
  try {
    names = (await readdir(WORKFLOW_DIR)).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => {
      const file = join(".github/workflows", name);
      try {
        return { file, doc: parse(await readFile(join(WORKFLOW_DIR, name), "utf8")), error: null };
      } catch (err) {
        return { file, doc: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

async function main() {
  const workflows = await readWorkflows();
  const violations = workflowTimeoutViolations(workflows);
  if (violations.length > 0) {
    console.error("✖ workflow runtime caps:\n");
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  const jobs = workflows.reduce((n, w) => n + Object.keys(w.doc?.jobs ?? {}).length, 0);
  console.log(
    `✔ workflow runtime caps: ${jobs} job(s) across ${workflows.length} workflow(s) declare a ` +
      `timeout-minutes below GitHub's ${MAX_TIMEOUT_MINUTES}-minute default, and every failure gate ` +
      `also sees a cancelled dependency.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
