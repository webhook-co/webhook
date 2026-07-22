// The auth Worker's scheduled() dispatch (ADR-0055 + S3 PR3c-3b).
//
// apps/auth declares a single HOURLY trigger ("0 * * * *", wrangler.jsonc) but runs one hourly job and one
// DAILY job behind it. That hourly-vs-daily split is real branching logic with a silent failure mode: get
// the hour wrong and the cross-org expiry sweep simply never runs again — no error, no alert, just rows
// that never expire.
//
// It lives HERE, not in src/worker.ts, because worker.ts is EXCLUDED from tsconfig (it imports the
// generated, gitignored `.open-next/worker.js`), so nothing in worker.ts is type-checked and no test can
// import it. Keeping the dispatch in this type-checked module mirrors how IssuerIntrospect delegates to
// ./issuer/introspect-handler, and leaves worker.ts holding a single delegating call — the smallest
// untyped surface available, and strictly less than the inline predicate + two cron imports it replaces.

import { runNotificationDrain } from "./notify-cron";
import { runAuthExpirySweep } from "./sweep-cron";

/** The UTC hour the daily cross-org expiry sweep runs on — a low-traffic window. */
export const EXPIRY_SWEEP_UTC_HOUR = 4;

/** The crons the scheduled handler fans out. Injected so the dispatch is testable without a database. */
export interface AuthScheduledCrons {
  /** Drains queued owner notifications. Runs EVERY hour, so an auto-disable email is at most ~1h late. */
  readonly notificationDrain: (env: Record<string, unknown>) => Promise<unknown>;
  /** Prunes expired auth handles across every org (ADR-0055). DAILY — see EXPIRY_SWEEP_UTC_HOUR. */
  readonly expirySweep: (env: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The real wiring. EXPORTED so a test can assert the identity of each field: every dispatch test injects
 * its own fakes, so without this the default is never executed, and swapping the two fields — or stubbing
 * both to no-ops — would leave the whole suite green while production ran the wrong crons on the wrong
 * cadence. Both have the same `(env) => Promise<…>` shape, so tsc cannot catch a swap either.
 */
export const DEFAULT_CRONS: AuthScheduledCrons = {
  notificationDrain: runNotificationDrain,
  expirySweep: runAuthExpirySweep,
};

/**
 * Whether this firing is the one that runs the DAILY expiry sweep. Read in UTC so the gate is independent
 * of the runtime's local timezone, and evaluated on the HOUR (not the exact instant) so a dispatch delayed
 * within the hour still sweeps.
 */
export function runsExpirySweep(scheduledTime: number | Date): boolean {
  return new Date(scheduledTime).getUTCHours() === EXPIRY_SWEEP_UTC_HOUR;
}

/**
 * Absorb a cron's failure into a structured log line.
 *
 * Both crons already catch internally, so this is a guard against REGRESSION, not routine control flow.
 * It matters because apps/auth never calls `controller.noRetry()`: an uncaught rejection would mark the
 * invocation failed AND leave the runtime's `retry` flag at its default of true, so the platform could
 * re-invoke and the notification drain could send an owner email twice. A duplicate email is worse than a
 * logged failure, so the dispatch swallows and names the failure instead.
 *
 * It reuses each cron's OWN `auth.*.cron.error` message rather than inventing a new one, so any existing
 * alert keyed on that string also sees a dispatch-level failure; `stage: "dispatch"` distinguishes the two.
 *
 * It logs the error's NAME, never its message. The only frame that can actually reach here is the
 * `createClient(...)` call in each cron, which sits OUTSIDE that cron's try block — and its live argument is
 * the Hyperdrive connection string, which embeds a role credential. Logging a raw message from that frame
 * would make non-leakage depend on an upstream library's error formatting, which nothing in this repo pins.
 * Everything inside the crons' try blocks is already logged, sanitised, by their own handlers. (no-secrets)
 */
async function absorb(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    // The cron is INVOKED inside the try, not passed in as an already-running promise. AuthScheduledCrons
    // types these as `=> Promise<…>`, not `async`, so a non-async implementation that threw before
    // returning its promise would propagate straight out of the dispatch, out of scheduled(), and skip
    // every cron below it — the exact outcome this helper exists to prevent.
    await run();
  } catch (error: unknown) {
    console.log(
      JSON.stringify({
        message,
        stage: "dispatch",
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

/**
 * Fan out the auth crons for one scheduled firing. Each cron is handed to `waitUntil` as its OWN unit, so
 * neither can starve the other (the runtime settles waitUntil units independently, like Promise.allSettled).
 */
export function dispatchAuthScheduled(
  event: { readonly scheduledTime: number | Date },
  env: Record<string, unknown>,
  waitUntil: (promise: Promise<unknown>) => void,
  crons: AuthScheduledCrons = DEFAULT_CRONS,
): void {
  waitUntil(absorb(() => crons.notificationDrain(env), "auth.notify.cron.error"));
  if (runsExpirySweep(event.scheduledTime)) {
    waitUntil(absorb(() => crons.expirySweep(env), "auth.sweep.cron.error"));
  }
}
