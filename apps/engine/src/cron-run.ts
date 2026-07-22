// Wall-clock supervision for one scheduled() invocation.
//
// Truncation is the only cron failure mode that leaves NO trace. `finishScheduled` joins the waitUntil set
// against the platform's 15-minute cron limit with `exclusiveJoin`, which CANCELS the losers — and a
// cancellation is not a rejection, so the cron's own error path never runs, `withHeartbeat` never reports,
// and nothing at all is logged. The run just stops mid-flight.
//
// The heartbeat layer does eventually notice (a truncated cron stops beating, so apps/health flags it BY
// NAME), and that remains the detector of record for "which job died". What it cannot do is say "this run
// was cut short", or say it promptly — an hourly job's window is three hours. This module closes that gap
// inside the invocation it happens in, and gives the elapsed-time trend that shows a fan-out drifting
// toward the limit before it crosses it.
//
// It deliberately does NOT name the unfinished crons. Naming them would mean threading an identifier
// through every dispatch site, and the heartbeat already supplies exactly that. A count plus the elapsed
// time is what this layer can know honestly.

/**
 * When to declare the run truncated.
 *
 * Well below the platform's 15-minute limit on purpose: the warning has to be EMITTED before the runtime
 * cancels the invocation. A deadline at the limit would mean the truncation warning is itself truncated,
 * which is the one outcome that makes this module pointless.
 */
export const CRON_RUN_DEADLINE_MS = 13 * 60_000;

/** A cancellable delay. Injected so tests need no real timers and no fake-timer globals. */
export interface CancellableDelay {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

export interface CronRunDeps {
  /** How long the fan-out may run before it is reported as truncated. */
  readonly deadlineMs: number;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
  readonly now: () => number;
  readonly delay: (ms: number) => CancellableDelay;
}

export interface CronRun {
  /** Register a dispatched unit. Returns it UNCHANGED so the dispatch site is unaffected. */
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  /** Watch the run and log its outcome. Resolves as soon as the fan-out settles, or at the deadline. */
  readonly supervise: (deps: CronRunDeps) => Promise<void>;
}

/** The real timer, as the Worker sees it. */
export const realDelay = (ms: number): CancellableDelay => {
  // The handle is assigned synchronously inside the Promise executor, so it is always set by the time
  // `cancel` can be called — but the type does not know that, and a non-null assertion here would be a
  // claim rather than a check. Guarding is free and cannot be wrong.
  let handle: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== null) clearTimeout(handle);
    },
  };
};

export function createCronRun(): CronRun {
  // `settled` counts units that have finished EITHER WAY. A rejection is not "unfinished": a failed cron
  // already has its own named log line and reports ok:false to the heartbeat, so counting it here would
  // double-report it and make a plain failure look like truncation.
  const units: Promise<unknown>[] = [];
  let settled = 0;

  return {
    track: (promise) => {
      units.push(promise);
      void promise.then(
        () => {
          settled += 1;
        },
        () => {
          settled += 1;
        },
      );
      return promise;
    },

    supervise: async (deps) => {
      const startedAt = deps.now();
      if (units.length === 0) {
        // Not a no-op worth skipping: zero units means the cadence gate returned before dispatching
        // anything, and seeing that in the log is how a mis-routed trigger becomes visible.
        deps.log("cron.run.complete", {
          dispatched: 0,
          unfinished: 0,
          elapsedMs: 0,
          truncated: false,
        });
        return;
      }

      const timer = deps.delay(deps.deadlineMs);
      // allSettled, never all: one rejecting unit must not make the supervisor itself reject. It is a
      // waitUntil unit, so a rejection here would mark the invocation failed — and since the runtime's
      // retry flag defaults to true, could invite a re-run of every cron.
      const finished = Promise.allSettled(units).then(() => "finished" as const);
      const outcome = await Promise.race([
        finished,
        timer.promise.then(() => "truncated" as const),
      ]);
      // Cancel unconditionally. A timer left pending holds the isolate open for its full duration on
      // EVERY tick, turning a two-second run into a thirteen-minute one.
      timer.cancel();

      const elapsedMs = deps.now() - startedAt;
      const unfinished = units.length - settled;
      if (outcome === "truncated") {
        deps.log("cron.run.truncated", {
          dispatched: units.length,
          unfinished,
          elapsedMs,
          deadlineMs: deps.deadlineMs,
          truncated: true,
        });
        return;
      }
      deps.log("cron.run.complete", {
        dispatched: units.length,
        unfinished: 0,
        elapsedMs,
        truncated: false,
      });
    },
  };
}
