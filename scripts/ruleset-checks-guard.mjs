// Every status check the `main` ruleset requires is a job CI can actually report.
//
// THE FAILURE THIS CATCHES IS UNRECOVERABLE-LOOKING AND SILENT. A required status check that never
// reports leaves every PR pending forever — GitHub waits for a check that will never arrive — and
// `main-status-checks.json` sets `bypass_actors: []`, so nobody, including admins, can merge past it
// through the UI. Rename a job in `ci.yml` without updating the ruleset and the entire repo is wedged,
// with no error message naming the cause: the PR simply sits at "Expected — Waiting for status to be
// reported". Nothing else in the repo checks this. That is how the file got 10 checks while the live
// ruleset had 15, and how it named `tsconfig-boundary` as required when it was not.
//
// WHAT THIS DOES AND DOES NOT PROVE. It compares the COMMITTED ruleset JSON against the job names every
// workflow actually defines, so it catches a rename, a typo, and a deleted job. It cannot see the LIVE
// ruleset — that needs a network call and an authenticated token, which a `lint` run has neither of.
// So this is the half that can be checked hermetically; keeping the file and GitHub in agreement is a
// human step, and `.github/rulesets/README.md` gives the one command that verifies it.
//
// It prefers each job's `name:` over its YAML key, because that is what GitHub reports a check under
// (falling back to the key when there is no `name:`). This repo sets both, usually identically but not
// always, so keying on the wrong one would produce confident nonsense.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULESET = ".github/rulesets/main-status-checks.json";
const WORKFLOW_DIR = ".github/workflows";

/**
 * Every workflow file, DISCOVERED rather than listed.
 *
 * A hardcoded list is the same defect this guard exists to catch, one level up: the first draft named
 * `ci.yml` and `codeql.yml`, and immediately reported `gitleaks` as unreportable — it lives in
 * `secret-scan.yml`. A guard that is wrong about where jobs live produces confident false alarms, and
 * the fix for a false alarm is usually to weaken the guard. Reading the directory means a new workflow
 * is covered the day it lands.
 */
function workflowFiles(repo = REPO) {
  try {
    return readdirSync(join(repo, WORKFLOW_DIR))
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => `${WORKFLOW_DIR}/${f}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The status-check contexts a ruleset file requires.
 *
 * Parsed from the JSON rather than pattern-matched out of the text: a regex over the file would happily
 * read a context out of a comment or a disabled block and report agreement that does not exist.
 */
export function requiredContexts(repo = REPO) {
  const doc = JSON.parse(readFileSync(join(repo, RULESET), "utf8"));
  const rule = (doc.rules ?? []).find((r) => r.type === "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? []).map((c) => c.context);
}

/**
 * Every check name a workflow can report: each job's `name:` when it has one, else its YAML key.
 *
 * Deliberately a small hand-rolled scan rather than a YAML dependency — the shape being read is two
 * levels deep and fixed (`jobs:` → a key at 2 spaces → an optional `name:` at 4). It keys on INDENTATION,
 * so a `name:` belonging to a step (6+ spaces) can never be mistaken for a job's.
 */
export function reportableChecks(repo = REPO, workflows = workflowFiles(repo)) {
  const names = new Set();
  for (const file of workflows) {
    let text;
    try {
      text = readFileSync(join(repo, file), "utf8");
    } catch {
      continue; // a workflow that does not exist contributes nothing; the missing-context check reports it
    }
    const lines = text.split("\n");
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt === -1) continue;

    let currentJob = null;
    for (const line of lines.slice(jobsAt + 1)) {
      if (/^\S/.test(line)) break; // dedented out of `jobs:` entirely
      // Tolerate a trailing comment on the job key. Without this a perfectly valid `  build: # notes`
      // reads as "not a job", the guard cries wolf, and the reflex fix for a false alarm is to weaken it.
      const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
      if (job) {
        if (currentJob) names.add(currentJob.name ?? currentJob.key);
        currentJob = { key: job[1], name: null };
        continue;
      }
      const name = line.match(/^ {4}name:\s*(.+?)\s*$/);
      if (name && currentJob && currentJob.name === null) {
        currentJob.name = name[1].replace(/^["']|["']$/g, "");
      }
    }
    if (currentJob) names.add(currentJob.name ?? currentJob.key);
  }
  return names;
}

/**
 * Job keys whose reported check name GitHub REWRITES, so a plain `name:` comparison cannot match.
 *
 *   - a `strategy: matrix` job reports as `name (value)` per combination;
 *   - a job with a top-level `uses:` (a reusable workflow) reports as `caller / callee-job`.
 *
 * No workflow here uses either today, so the guard is accurate as written — but if one lands, requiring
 * that check would wedge the repo in exactly the way this guard exists to prevent, and the guard would
 * report green. Detecting the shape and refusing to vouch for it is the honest behaviour.
 */
export function jobsWithRewrittenNames(repo = REPO, workflows = workflowFiles(repo)) {
  const found = [];
  for (const file of workflows) {
    let text;
    try {
      text = readFileSync(join(repo, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt === -1) continue;
    let key = null;
    for (const line of lines.slice(jobsAt + 1)) {
      if (/^\S/.test(line)) break;
      const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
      if (job) {
        key = job[1];
        continue;
      }
      if (key && /^ {4}(strategy:|uses:)/.test(line)) {
        found.push(`${file}:${key}`);
        key = null;
      }
    }
  }
  return found;
}

/** Required contexts with no job that could ever report them. These wedge the repo. */
export function unreportableContexts(repo = REPO, workflows = workflowFiles(repo)) {
  const reportable = reportableChecks(repo, workflows);
  return requiredContexts(repo).filter((c) => !reportable.has(c));
}

function main() {
  const contexts = requiredContexts();
  const orphans = unreportableContexts();

  if (contexts.length === 0) {
    console.error(
      `${RULESET} requires NO status checks. That is almost certainly a mistake — an empty list ` +
        `silently disables the CI gate on main.`,
    );
    process.exit(1);
  }
  if (orphans.length > 0) {
    console.error(
      `Required status ${orphans.length === 1 ? "check names a job" : "checks name jobs"} that CI ` +
        `cannot report:\n${orphans.map((c) => `  - ${c}`).join("\n")}\n\n` +
        `Every context in ${RULESET} must match a job's \`name:\` in some ${WORKFLOW_DIR}/*.yml.\n` +
        `Left unfixed, GitHub waits forever for a check that never arrives, and \`bypass_actors\` is ` +
        `empty — so every PR is unmergeable with no error naming the cause.`,
    );
    process.exit(1);
  }
  const rewritten = jobsWithRewrittenNames();
  if (rewritten.length > 0) {
    console.error(
      `These jobs report under a name GitHub REWRITES (matrix → "name (value)", reusable workflow →\n` +
        `"caller / callee"), which this guard cannot match:\n` +
        `${rewritten.map((j) => `  - ${j}`).join("\n")}\n\n` +
        `If any of them is (or becomes) a required check, the ruleset will wait forever for a context\n` +
        `that never arrives. Teach the guard the rewritten shape before requiring one.`,
    );
    process.exit(1);
  }
  console.log(
    `ruleset-checks-guard: all ${contexts.length} required checks map to a reportable CI job.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
