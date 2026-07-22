import { describe, expect, it } from "vitest";

import worker, { type Env } from "./index.js";

// The scheduled() DISPATCH BODY. apps/api declares `"crons": ["0 * * * *"]` and fans out two billing
// crons via ctx.waitUntil, but nothing invoked the handler: index.test.ts imports the default export and
// only ever calls worker.fetch. So a deleted ctx.waitUntil(...) would have failed no test, and the cron
// would silently stop running — a paying customer's subscription never cancelled, or a retention window
// never repaired, with no error anywhere.
//
// Unlike apps/engine this pool is plain Node (vitest.config.ts `environment: "node"`), so the
// ExecutionContext is hand-rolled rather than built by cloudflare:test.

/** Records every unit handed to ctx.waitUntil so the test can count and settle them. */
function recordingCtx(): { ctx: ExecutionContext; units: Promise<unknown>[] } {
  const units: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      units.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, units };
}

const controller = {
  cron: "0 * * * *",
  scheduledTime: 1_700_000_000_000,
  noRetry() {},
} as unknown as ScheduledController;

/** A bare Env: BILLING_MODE unset, so both crons take their dark-launch path and no-op cleanly. */
const bareEnv = {} as Env;

describe("apps/api scheduled() dispatch", () => {
  it("dispatches BOTH billing crons as independent units, and neither rejects when unprovisioned", async () => {
    const { ctx, units } = recordingCtx();

    await worker.scheduled!(controller, bareEnv, ctx);

    // Two units, not one: the retention reconciler and the cancellation drain must be handed to
    // waitUntil separately, so neither can starve the other. Delete either ctx.waitUntil(...) and this
    // reads 1.
    //
    // This pins CARDINALITY only. WHICH two crons — and that each is handed `env` and left deliberately
    // unwrapped so a failure still reaches the Cron Trigger status — is pinned statically by
    // scripts/cron-dispatch-guard.mjs, because a promise is opaque and both crons are dark no-ops here.
    // Without that guard, swapping one cron for a duplicate of the other would pass this test while a
    // hard-deleted org kept being charged.
    expect(units).toHaveLength(2);

    // A scheduled handler has no caller to answer, so a misconfigured deployment must be a SILENT no-op,
    // never a rejection that marks the whole invocation failed. Both crons self-guard on BILLING_MODE /
    // the Hyperdrive binding; this asserts the dispatch actually honours that.
    await expect(Promise.all(units)).resolves.toHaveLength(2);
  });
});
