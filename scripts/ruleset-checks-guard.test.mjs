import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  jobsWithRewrittenNames,
  reportableChecks,
  requiredContexts,
  unreportableContexts,
} from "./ruleset-checks-guard.mjs";

// The guard is run against BOTH the real repo and synthetic fixtures. Fixtures alone would prove only
// that the parser works on inputs written to suit it; the real-repo assertions are what prove it is
// pointed at the files that actually exist.

/** A throwaway repo with a ruleset file and a workflow, so a violation can be constructed on purpose. */
function fixture({ contexts, workflow }) {
  const repo = mkdtempSync(join(tmpdir(), "ruleset-guard-"));
  mkdirSync(join(repo, ".github/rulesets"), { recursive: true });
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github/rulesets/main-status-checks.json"),
    JSON.stringify({
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: contexts.map((c) => ({ context: c })) },
        },
      ],
    }),
  );
  writeFileSync(join(repo, ".github/workflows/ci.yml"), workflow);
  return repo;
}

const CI = `name: CI
on:
  pull_request:
jobs:
  install:
    name: install
    runs-on: ubuntu-latest
    steps:
      - name: this step name must NOT be read as a job
        run: echo hi
  keyed-only:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  renamed:
    name: the reported name
    runs-on: ubuntu-latest
`;

test("reads a job's `name:` when present", () => {
  const repo = fixture({ contexts: ["the reported name"], workflow: CI });
  assert.deepEqual(unreportableContexts(repo, [".github/workflows/ci.yml"]), []);
});

test("falls back to the YAML key when a job has no `name:`", () => {
  const repo = fixture({ contexts: ["keyed-only"], workflow: CI });
  assert.deepEqual(unreportableContexts(repo, [".github/workflows/ci.yml"]), []);
});

// The bug this guard exists for: a job renamed without updating the ruleset. GitHub then waits forever
// for a check nobody will report, and bypass_actors is empty, so every PR is stuck.
test("FLAGS a required context that no job can report", () => {
  const repo = fixture({ contexts: ["renamed"], workflow: CI });
  assert.deepEqual(unreportableContexts(repo, [".github/workflows/ci.yml"]), ["renamed"]);
});

// A step's `name:` sits at 6 spaces and must never be mistaken for a job's at 4 — otherwise the guard
// reports agreement that does not exist, which is worse than no guard.
test("never reads a STEP name as a reportable check", () => {
  const repo = fixture({
    contexts: ["this step name must NOT be read as a job"],
    workflow: CI,
  });
  assert.deepEqual(unreportableContexts(repo, [".github/workflows/ci.yml"]), [
    "this step name must NOT be read as a job",
  ]);
});

test("a missing workflow file does not crash the guard", () => {
  const repo = fixture({ contexts: ["install"], workflow: CI });
  assert.deepEqual(
    unreportableContexts(repo, [".github/workflows/ci.yml", ".github/workflows/nope.yml"]),
    [],
  );
});

// --- against the REAL repo ---------------------------------------------------------------------------

test("the repo's own ruleset requires checks, and every one is reportable", () => {
  const contexts = requiredContexts();
  assert.ok(contexts.length > 0, "an empty required list silently disables the gate on main");
  assert.deepEqual(
    unreportableContexts(),
    [],
    "a required check with no job wedges every PR — see the guard's header",
  );
});

test("the real ci.yml parses into a plausible number of jobs", () => {
  // A parser that silently matched nothing would make every assertion above vacuously pass.
  assert.ok(
    reportableChecks().size > 20,
    `expected many reportable jobs, found ${reportableChecks().size} — the parser is probably broken`,
  );
});

test("auth-e2e is required — the login page's only real-browser gate", () => {
  assert.ok(requiredContexts().includes("auth-e2e"));
});

// GitHub rewrites the reported check name for two job shapes, so a plain `name:` comparison silently
// cannot match them — and the guard would report green while the ruleset waits forever.
test("detects a matrix job, whose check name GitHub rewrites", () => {
  const repo = fixture({
    contexts: ["install"],
    workflow: `jobs:
  install:
    name: install
    runs-on: ubuntu-latest
  fanned:
    name: fanned
    strategy:
      matrix:
        node: [20, 22]
`,
  });
  assert.deepEqual(jobsWithRewrittenNames(repo, [".github/workflows/ci.yml"]), [
    ".github/workflows/ci.yml:fanned",
  ]);
});

test("detects a reusable-workflow job", () => {
  const repo = fixture({
    contexts: ["install"],
    workflow: `jobs:
  install:
    name: install
    runs-on: ubuntu-latest
  delegated:
    uses: ./.github/workflows/other.yml
`,
  });
  assert.deepEqual(jobsWithRewrittenNames(repo, [".github/workflows/ci.yml"]), [
    ".github/workflows/ci.yml:delegated",
  ]);
});

test("a job key with a trailing comment is still a job (no false alarm)", () => {
  const repo = fixture({
    contexts: ["commented"],
    workflow: `jobs:
  commented: # this is fine
    name: commented
    runs-on: ubuntu-latest
`,
  });
  assert.deepEqual(unreportableContexts(repo, [".github/workflows/ci.yml"]), []);
});

test("the real repo uses neither rewritten shape today", () => {
  assert.deepEqual(jobsWithRewrittenNames(), []);
});
