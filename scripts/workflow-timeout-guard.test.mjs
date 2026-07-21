// Tests for the workflow timeout/cancelled guard (#729 §3).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TIMEOUT_MINUTES,
  readWorkflows,
  workflowTimeoutViolations,
} from "./workflow-timeout-guard.mjs";

/** Shorthand: build a parsed-workflow record the rule accepts. */
const wf = (file, jobs) => ({ file, doc: { jobs }, error: null });

// ── the floor ─────────────────────────────────────────────────────────────────────────────────
test("fails closed when no workflows were read at all", () => {
  const v = workflowTimeoutViolations([]);
  assert.ok(v.length > 0);
  assert.match(v.join("\n"), /no workflow files/i);
});

test("fails closed on a workflow that could not be parsed", () => {
  const v = workflowTimeoutViolations([{ file: "x.yml", doc: null, error: "bad indent" }]);
  assert.match(v.join("\n"), /could not be parsed/i);
});

test("fails closed on a workflow that declares no jobs", () => {
  const v = workflowTimeoutViolations([wf("x.yml", {})]);
  assert.match(v.join("\n"), /declares no jobs/i);
});

// ── every job needs a cap ─────────────────────────────────────────────────────────────────────
test("flags a job with no timeout-minutes", () => {
  const v = workflowTimeoutViolations([wf("ci.yml", { build: { "runs-on": "ubuntu-latest" } })]);
  assert.equal(v.length, 1);
  assert.match(v[0], /ci\.yml.*build.*timeout-minutes/s);
});

test("accepts a job with a sane timeout-minutes", () => {
  assert.deepEqual(
    workflowTimeoutViolations([wf("ci.yml", { build: { "timeout-minutes": 30 } })]),
    [],
  );
});

test("rejects a timeout at or above GitHub's 360-minute default (it would buy nothing)", () => {
  const v = workflowTimeoutViolations([wf("ci.yml", { build: { "timeout-minutes": 360 } })]);
  assert.equal(v.length, 1);
  assert.match(v[0], new RegExp(String(MAX_TIMEOUT_MINUTES)));
});

test("rejects a non-integer or non-positive timeout", () => {
  for (const bad of ["30", 0, -5, 12.5, null, true]) {
    const v = workflowTimeoutViolations([wf("ci.yml", { build: { "timeout-minutes": bad } })]);
    assert.equal(v.length, 1, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// ── the pairing that makes the cap safe ───────────────────────────────────────────────────────
// A JOB timeout CANCELS the job. `failure()` is false for a cancelled job, so adding a cap without
// widening the gate would SILENCE the alert instead of reporting it — turning a runaway into
// silence, which is strictly worse than the runaway. This is the RED the issue asked to prove.
test("flags a failure()-gated job that cannot see a cancelled dependency", () => {
  const v = workflowTimeoutViolations([
    wf("nightly-rls.yml", {
      "rls-neon": { "timeout-minutes": 320 },
      "open-issue-on-failure": { "timeout-minutes": 10, needs: "rls-neon", if: "failure()" },
    }),
  ]);
  assert.equal(v.length, 1);
  assert.match(v[0], /cancelled/i);
  assert.match(v[0], /open-issue-on-failure/);
});

test("flags the `needs.X.result == 'failure'` spelling of the same gap", () => {
  const v = workflowTimeoutViolations([
    wf("nightly-rls.yml", {
      "rls-neon": { "timeout-minutes": 320 },
      report: {
        "timeout-minutes": 10,
        needs: ["rls-neon"],
        if: "${{ always() && needs.rls-neon.result == 'failure' }}",
      },
    }),
  ]);
  assert.equal(v.length, 1);
  assert.match(v[0], /cancelled/i);
});

test("accepts a gate that covers cancelled as well as failure", () => {
  const v = workflowTimeoutViolations([
    wf("nightly-rls.yml", {
      "rls-neon": { "timeout-minutes": 320 },
      report: {
        "timeout-minutes": 10,
        needs: ["rls-neon"],
        if: "${{ always() && (needs.rls-neon.result == 'failure' || needs.rls-neon.result == 'cancelled') }}",
      },
    }),
  ]);
  assert.deepEqual(v, []);
});

test("a job with no failure gate at all is not asked about cancelled", () => {
  const v = workflowTimeoutViolations([
    wf("ci.yml", { a: { "timeout-minutes": 10 }, b: { "timeout-minutes": 10, needs: "a" } }),
  ]);
  assert.deepEqual(v, []);
});

test("`success() || failure()` still counts as a failure gate and must cover cancelled", () => {
  const v = workflowTimeoutViolations([
    wf("x.yml", {
      a: { "timeout-minutes": 5 },
      b: { "timeout-minutes": 5, needs: "a", if: "success() || failure()" },
    }),
  ]);
  assert.equal(v.length, 1);
});

// ── the assertion that actually blocks the bug ────────────────────────────────────────────────
test("every job in every committed workflow declares a cap, and every failure gate sees cancelled", async () => {
  const workflows = await readWorkflows();
  // Vacuity checks: a glob matching nothing, or a parser returning empty docs, reads as clean.
  assert.ok(workflows.length >= 15, `expected the repo's workflows, got ${workflows.length}`);
  const jobs = workflows.reduce((n, w) => n + Object.keys(w.doc?.jobs ?? {}).length, 0);
  assert.ok(jobs >= 30, `expected the repo's jobs, got ${jobs}`);
  assert.deepEqual(workflowTimeoutViolations(workflows), []);
});

test("the guard PARSES yaml rather than text-scanning (a quoted `timeout-minutes` in prose is not a cap)", async () => {
  // A regex over the file would be satisfied by the string appearing anywhere — including inside a
  // comment or a `run:` block. Only a real parse can tell the difference.
  const v = workflowTimeoutViolations([
    {
      file: "x.yml",
      doc: { jobs: { build: { steps: [{ run: "echo timeout-minutes: 30" }] } } },
      error: null,
    },
  ]);
  assert.equal(
    v.length,
    1,
    "a timeout-minutes mentioned inside a step must not count as the job's cap",
  );
});

// ── regressions found by adversarial review ───────────────────────────────────────────────────

test("a NEGATIVE mention of cancelled does not count as covering it", () => {
  // `!= 'cancelled'` and `!cancelled()` both contain the token while EXCLUDING the case. A substring
  // test reads them as compliance, which is the opposite of what they do.
  for (const gate of [
    "${{ always() && needs.a.result == 'failure' && needs.a.result != 'cancelled' }}",
    "${{ !cancelled() && needs.a.result == 'failure' }}",
  ]) {
    const v = workflowTimeoutViolations([
      wf("x.yml", {
        a: { "timeout-minutes": 5 },
        b: { "timeout-minutes": 5, needs: "a", if: gate },
      }),
    ]);
    assert.equal(v.length, 1, `expected a violation for: ${gate}`);
  }
});

test("an AFFIRMATIVE cancelled check on the depended-on job is accepted", () => {
  const v = workflowTimeoutViolations([
    wf("x.yml", {
      a: { "timeout-minutes": 5 },
      b: {
        "timeout-minutes": 5,
        needs: "a",
        if: "${{ !cancelled() && (needs.a.result == 'failure' || needs.a.result == 'cancelled') }}",
      },
    }),
  ]);
  assert.deepEqual(v, []);
});

test("a reusable-workflow call cannot carry a cap, so it is not asked for one", () => {
  // GitHub's job schema rejects timeout-minutes on a job that is `uses:` — demanding one would make
  // the guard unsatisfiable. The callee's OWN jobs are capped by this same guard, so nothing is lost.
  const v = workflowTimeoutViolations([
    wf("x.yml", { call: { uses: "./.github/workflows/reusable.yml" } }),
  ]);
  assert.deepEqual(v, []);
});

test("...but an OUT-OF-REPO reusable workflow is still flagged (its jobs are not covered here)", () => {
  const v = workflowTimeoutViolations([
    wf("x.yml", { call: { uses: "some-org/other-repo/.github/workflows/x.yml@v1" } }),
  ]);
  assert.equal(v.length, 1);
  assert.match(v[0], /out-of-repo|external/i);
});
