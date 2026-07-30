import assert from "node:assert/strict";
import { test } from "node:test";

import { CRON_APPS, DEV_APPS, devCommand } from "./dev-ports.mjs";
import { JOBS, jobRegistry, scheduledUrl } from "./dev-cron.mjs";

// Cron work had NO local trigger at all: you could read the handler or wait an hour. `--test-scheduled`
// exposes /__scheduled?cron=<expr>, which invokes the Worker's REAL scheduled() handler — no fake
// transport and no mode flag, which is what makes this parity rather than a substitute.

test("every job resolves to an app with a registered dev port", () => {
  assert.ok(JOBS.size >= 15, `expected ≥15 jobs, found ${JOBS.size}`);
  for (const [name, job] of JOBS) {
    assert.ok(DEV_APPS[job.app], `${name} targets app "${job.app}", which has no dev port`);
    assert.match(job.expr, /^[\d*/,\- ]+$/, `${name}: "${job.expr}" is not a cron expression`);
  }
});

test("every app that declares a cron runs with --test-scheduled", () => {
  // Without the flag the endpoint does not exist and `pnpm cron` cannot reach the handler at all.
  assert.ok(CRON_APPS.size >= 4, `only ${CRON_APPS.size} cron apps discovered`);
  for (const app of CRON_APPS) {
    assert.match(devCommand(app), /--test-scheduled/, `${app} declares a cron but cannot be fired`);
  }
});

test("an app with NO cron does not get the flag", () => {
  const quiet = Object.keys(DEV_APPS).filter(
    (a) => !CRON_APPS.has(a) && DEV_APPS[a].kind !== "next",
  );
  assert.ok(quiet.length > 0, "no cron-less worker to check — the test would be vacuous");
  for (const app of quiet) {
    assert.ok(!devCommand(app).includes("--test-scheduled"), `${app} has no cron but got the flag`);
  }
});

test("the URL targets the app's pinned port and encodes the expression", () => {
  const url = scheduledUrl(JOBS.get("cap-producer"));
  assert.match(url, new RegExp(`127\\.0\\.0\\.1:${DEV_APPS.engine.port}/__scheduled\\?cron=`));
  assert.ok(url.includes(encodeURIComponent("*/5 * * * *")), "the cron expression was not encoded");
  assert.ok(!url.includes("* * *"), "an unencoded space would be a malformed query string");
});

// The load-bearing honesty check. A cron EXPRESSION is the unit Cloudflare schedules, not a job: the
// engine fans 14 jobs out of its hourly tick. If `alsoRuns` were empty the tool would imply an isolation
// that does not exist, and someone would read a side effect as coming from the job they asked for.
test("a job that shares its tick discloses every other job on it", () => {
  const anchor = JOBS.get("anchor");
  assert.ok(anchor.alsoRuns.length >= 10, "the hourly fan-out was not disclosed");
  assert.ok(!anchor.alsoRuns.includes("anchor"), "a job must not list itself");
  for (const other of anchor.alsoRuns) {
    assert.equal(JOBS.get(other).expr, anchor.expr, `${other} is not actually on the same tick`);
    assert.equal(JOBS.get(other).app, anchor.app, `${other} is not even the same app`);
  }
});

test("a job alone on its tick discloses nothing", () => {
  // The 5-minute tick runs ONLY the cap producer — the one case where a job really is isolated.
  assert.deepEqual(JOBS.get("cap-producer").alsoRuns, []);
});

test("an unknown cadence is a loud error, not a silent skip", () => {
  assert.throws(
    () =>
      jobRegistry([{ label: "apps/x", crons: { runXCron: { cadence: "weekly", beat: "x" } } }], {}),
    /unknown cadence/,
  );
});

test("job names come from the dispatch guard's beats, so they cannot drift", () => {
  // `anchor` and `meter-rollup` are pinned by cron-dispatch-guard; renaming one there fails that guard
  // first, rather than silently leaving `pnpm cron` pointing at a name nothing dispatches.
  for (const beat of ["anchor", "meter-rollup", "cap-producer"]) {
    assert.ok(JOBS.has(beat), `${beat} is no longer a known job`);
  }
});
