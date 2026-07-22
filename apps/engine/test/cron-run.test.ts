import { describe, expect, it } from "vitest";

import { CRON_RUN_DEADLINE_MS, createCronRun, type CronRunDeps } from "../src/cron-run";

// Wall-clock truncation is the one cron failure mode that leaves NO trace at all.
//
// `finishScheduled` joins the waitUntil set against a 15-minute limit with `exclusiveJoin`, which CANCELS
// the losers. A cancellation is not a rejection, so the cron's own error path never runs, `withHeartbeat`
// never reports, and nothing is logged — the run simply stops mid-flight. The heartbeat layer eventually
// notices (a truncated cron stops beating, so apps/health flags it by name), but only after that job's
// window elapses — up to three hours for the hourly jobs. This supervisor makes the truncation itself
// visible in the same invocation it happens in.
//
// It must also be free when nothing is wrong: the deadline timer is cancelled the moment the fan-out
// settles, because a timer left pending would hold the isolate open for its full duration on EVERY tick.

/** A controllable clock + timer, so no test waits on real time. */
function fakeTimers(startMs = 1_000_000) {
  let now = startMs;
  const pending: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    deps: {
      now: () => now,
      delay: (ms: number) => {
        const entry = { at: now + ms, fire: () => {}, cancelled: false };
        const promise = new Promise<void>((resolve) => {
          entry.fire = resolve;
        });
        pending.push(entry);
        return { promise, cancel: () => (entry.cancelled = true) };
      },
    },
    /** Advance the clock and fire every timer whose deadline has passed and which was not cancelled. */
    advance: async (ms: number) => {
      now += ms;
      for (const t of pending) if (!t.cancelled && t.at <= now) t.fire();
      await Promise.resolve();
      await Promise.resolve();
    },
    cancelled: () => pending.filter((t) => t.cancelled).length,
    live: () => pending.filter((t) => !t.cancelled).length,
  };
}

function deps(over: Partial<CronRunDeps> & Pick<CronRunDeps, "now" | "delay">): CronRunDeps {
  return { deadlineMs: CRON_RUN_DEADLINE_MS, log: () => {}, ...over };
}

/** A promise the test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createCronRun", () => {
  it("returns the tracked promise unchanged, so dispatch is unaffected", async () => {
    const run = createCronRun();
    const value = Promise.resolve("x");

    const tracked = run.track(value);

    expect(tracked).toBe(value);
    await expect(tracked).resolves.toBe("x");
  });

  it("logs a clean completion with the unit count and elapsed time", async () => {
    const timers = fakeTimers();
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const run = createCronRun();
    run.track(Promise.resolve());
    run.track(Promise.resolve());

    const supervising = run.supervise(
      deps({ ...timers.deps, log: (message, fields) => logs.push({ message, fields }) }),
    );
    await timers.advance(0);
    await supervising;

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("cron.run.complete");
    expect(logs[0].fields?.dispatched).toBe(2);
    expect(logs[0].fields?.truncated).toBe(false);
  });

  it("CANCELS the deadline timer once the fan-out settles", async () => {
    // Without this the timer stays pending for its full duration on every tick, holding the isolate open
    // and turning a 2-second run into a 13-minute one.
    const timers = fakeTimers();
    const run = createCronRun();
    run.track(Promise.resolve());

    const supervising = run.supervise(deps(timers.deps));
    await timers.advance(0);
    await supervising;

    expect(timers.cancelled()).toBe(1);
    expect(timers.live()).toBe(0);
  });

  it("reports a TRUNCATED run, naming how many units were still unfinished", async () => {
    const timers = fakeTimers();
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const run = createCronRun();
    const stuck = deferred();
    const alsoStuck = deferred();
    run.track(Promise.resolve()); // finished
    run.track(stuck.promise); // still running at the deadline
    run.track(alsoStuck.promise);

    const supervising = run.supervise(
      deps({ ...timers.deps, log: (message, fields) => logs.push({ message, fields }) }),
    );
    await timers.advance(CRON_RUN_DEADLINE_MS);
    await supervising;

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("cron.run.truncated");
    expect(logs[0].fields?.truncated).toBe(true);
    expect(logs[0].fields?.dispatched).toBe(3);
    expect(logs[0].fields?.unfinished).toBe(2);

    stuck.resolve();
    alsoStuck.resolve();
  });

  it("does not count a FAILED unit as unfinished in a TRUNCATED run", async () => {
    // A cron that failed has its own named log line and reports ok:false to the heartbeat. Counting it as
    // unfinished would double-report it and overstate how much work the deadline actually cut short.
    //
    // This has to be asserted on the TRUNCATED path: the clean-completion branch reports unfinished 0 by
    // construction, so a run that finishes cannot distinguish "settled by rejecting" from "never settled".
    // An earlier version of this test used the completion path and passed even with the rejection
    // bookkeeping deleted.
    const timers = fakeTimers();
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const run = createCronRun();
    const stuck = deferred();
    run.track(Promise.reject(new Error("boom"))); // ran and FAILED — settled, not unfinished
    run.track(stuck.promise); // genuinely still running at the deadline

    const supervising = run.supervise(
      deps({ ...timers.deps, log: (message, fields) => logs.push({ message, fields }) }),
    );
    await timers.advance(CRON_RUN_DEADLINE_MS);
    await supervising;

    expect(logs[0].message).toBe("cron.run.truncated");
    expect(logs[0].fields?.dispatched).toBe(2);
    expect(logs[0].fields?.unfinished).toBe(1);

    stuck.resolve();
  });

  it("never rejects, whatever the tracked units do", async () => {
    // The supervisor is itself a waitUntil unit. If it rejected it would mark the invocation failed and,
    // since the runtime's retry flag defaults to true, could invite a re-run of every cron.
    const timers = fakeTimers();
    const run = createCronRun();
    run.track(Promise.reject(new Error("unhandled")));

    const supervising = run.supervise(deps(timers.deps));
    await timers.advance(0);

    await expect(supervising).resolves.toBeUndefined();
  });

  it("logs a completion even when nothing was dispatched", async () => {
    // A zero-unit run is itself a signal: the cadence gate returned early and no cron ran at all.
    const timers = fakeTimers();
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const run = createCronRun();

    await run.supervise(
      deps({ ...timers.deps, log: (message, fields) => logs.push({ message, fields }) }),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0].fields?.dispatched).toBe(0);
  });

  it("keeps the deadline safely below the platform's 15-minute cron limit", () => {
    // The log has to be EMITTED before the runtime cancels the invocation, so the deadline must leave
    // real margin. Pinned as a literal: drifting it up to 15 minutes would mean the truncation warning is
    // itself truncated, which is the one outcome that makes this module pointless.
    expect(CRON_RUN_DEADLINE_MS).toBeLessThanOrEqual(13 * 60_000);
    expect(CRON_RUN_DEADLINE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
