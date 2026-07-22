import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { CAP_PRODUCER_CRON, HOURLY_CRON, type Env } from "../src/index";

// The scheduled() DISPATCH BODY (index.ts) — the fan-out itself, not the pure routing helper that
// scheduled-cron-plan.test.ts already covers. Nothing else in the suite invokes the worker's default
// export, so without this file a deleted ctx.waitUntil(...) block would ship green and the cron would
// simply stop running in production, with no error to alert on.
//
// WHY A HAND-BUILT Env RATHER THAN `env` FROM cloudflare:test: the pool builds `env` from
// wrangler.jsonc, which declares ALL 12 Hyperdrive bindings (the `@gen-optional` markers are stripped
// by the DEPLOY overlay, not by Miniflare). Under that env every dark-launch guard is defeated and the
// unguarded crons dial 127.0.0.1:5432 for real — observed: 32 `Stream was cancelled` unhandled
// rejections, i.e. a non-deterministically red run. A bare Env keeps the pass hermetic and fast.
//
// WHAT A BARE Env PARTITIONS THE 15 CRONS INTO, and why that is the assertion:
//   - 9 crons hit a real dark-launch guard (`if (!env.HYPERDRIVE_x) return`, or BILLING_MODE off) and
//     no-op silently, emitting nothing;
//   - 6 crons have no binding guard, so they throw reading `.connectionString` of undefined and are
//     absorbed by their own `.catch()`, emitting exactly one named failure line each.
// Pinning WHICH crons land in which partition tests the dark gates too: invert any `!` on a guard and
// that cron moves from the silent set to the failing set, and the exact-set assertion goes red.
const failureNames = (logs: readonly string[]): string[] =>
  logs
    .map((line) => {
      try {
        return JSON.parse(line) as { message?: unknown };
      } catch {
        return {};
      }
    })
    .map((entry) => entry.message)
    .filter((m): m is string => typeof m === "string" && m.endsWith(" cron failed"))
    .sort();

/** A bare Env — NOTHING is bound. Every cron either hits a dark-launch guard or throws reading
 *  `.connectionString` of undefined on its first statement, so no binding needs stubbing: the two crons
 *  that touch KV_CONFIG reach it only after a Hyperdrive access that has already thrown, or behind
 *  `if (!env.HYPERDRIVE_RETENTION) return`. Verified by removing the stub and re-running. */
function bareEnv(): Env {
  return {} as unknown as Env;
}

/** ScheduledController is structurally simple and nothing validates it, so a literal is enough.
 *  (`ctx`, by contrast, MUST come from createExecutionContext — its queue is behind a private symbol.) */
function controller(cron: string): ScheduledController {
  return {
    cron,
    scheduledTime: 1_700_000_000_000,
    noRetry() {},
  } as unknown as ScheduledController;
}

/** Drive one scheduled() invocation, capturing every waitUntil unit and every log line. */
async function invoke(cron: string): Promise<{ units: number; failures: string[] }> {
  const ctx = createExecutionContext();
  const dispatched = vi.spyOn(ctx, "waitUntil");
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });

  await worker.scheduled!(controller(cron), bareEnv(), ctx);
  const units = dispatched.mock.calls.length;

  // Resolves only if EVERY unit settled without rejecting — i.e. no cron's failure escaped its
  // own .catch() to become an unhandled rejection at the invocation boundary.
  await waitOnExecutionContext(ctx);
  return { units, failures: failureNames(logs) };
}

// The 6 crons with no binding guard, so a bare Env drives each through its own .catch().
// These strings are ALERT-MATCHED log prefixes — changing one is an observability change, not a rename.
const UNGUARDED_FAILURES = [
  "activation rollup cron failed",
  "audit anchor cron failed",
  "cap producer cron failed",
  "delivery reconciler cron failed",
  "delivery stats rollup cron failed",
  "metering rollup cron failed",
].sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled() dispatch", () => {
  it("dispatches every cron as its OWN waitUntil unit on the hourly trigger", async () => {
    const { units } = await invoke(HOURLY_CRON);
    // One unit per cron: 14 hourly jobs + the cap-producer backstop. A dropped ctx.waitUntil(...)
    // shows up here as 14. (The AST guard pins WHICH 15 by identifier; a count alone could not.)
    expect(units).toBe(15);
  });

  it("runs ONLY the cap producer on the */5 trigger — by name, not by count", async () => {
    const { units, failures } = await invoke(CAP_PRODUCER_CRON);
    // The 12x guard: anything moved ABOVE `if (!plan.runsHourly) return` would run every 5 minutes
    // instead of hourly. Asserting the NAME (not just the count) means a heavy cron promoted above
    // the early return is caught even if some other cron were removed in the same edit.
    expect(failures).toEqual(["cap producer cron failed"]);
    expect(units).toBe(1);
  });

  it("absorbs every cron failure — one failing does not sink the invocation", async () => {
    // Six crons genuinely throw here. waitOnExecutionContext (inside invoke) resolving is the
    // assertion: every failure was caught per-cron, so none surfaced as an unhandled rejection.
    // Drop any single `.catch(...)` and this rejects with that cron's error.
    const { failures } = await invoke(HOURLY_CRON);
    expect(failures).toEqual(UNGUARDED_FAILURES);
  });

  it("FAILS SAFE on an unrecognised expression — runs the hourly fan-out, not just the cap", async () => {
    // Mirrors scheduledCronPlan's fallthrough, but asserted on the DISPATCH: an unknown trigger must
    // never silently degrade to cap-only and quietly stop the rollups/reconcilers/purges.
    const { units, failures } = await invoke("*/17 * * * *");
    expect(units).toBe(15);
    expect(failures).toEqual(UNGUARDED_FAILURES);
  });
});
