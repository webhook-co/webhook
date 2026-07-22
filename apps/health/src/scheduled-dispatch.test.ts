import { describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";

// The scheduled() DISPATCH BODY. apps/health declares `"crons": ["*/5 * * * *"]` and fans the delivery
// canary out of scheduled(), but nothing invoked the handler — index.test.ts exercises handleFetch only.
// So a deleted ctx.waitUntil(...) would have failed no test, and the canary would simply stop ticking.
//
// That failure mode is worse here than elsewhere: this Worker EXISTS to notice when other things stop.
// A silently dead canary reports nothing wrong, forever, which reads exactly like a healthy system.
//
// (This app is not covered by scripts/cron-dispatch-guard.mjs: that guard keys on `runXCron(env)` calls
// and their per-cron `.catch()`, and this dispatch is a single `runCanaryTick({...deps})` with an
// injected-deps object and no catch. Its cron TRIGGER is pinned by the guard.)

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
  cron: "*/5 * * * *",
  scheduledTime: 1_700_000_000_000,
  noRetry() {},
} as unknown as ScheduledController;

/** An in-memory KV, plus a canary sink that records every send. */
function envWith(): { env: Env; store: Map<string, string>; sent: string[] } {
  const store = new Map<string, string>();
  const sent: string[] = [];
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
  // No CANARY_URL / token: sendCanaryEvent then fails or no-ops, which is the point — the tick must
  // still advance the stored state so the next tick can correlate.
  return { env: { HEALTH_KV: kv } as unknown as Env, store, sent };
}

describe("apps/health scheduled() dispatch", () => {
  it("dispatches the canary tick as a waitUntil unit that settles without rejecting", async () => {
    const { ctx, units } = recordingCtx();
    const { env } = envWith();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled!(controller, env, ctx);

    // Exactly one unit — delete the ctx.waitUntil(...) and this reads 0, which is the whole point:
    // the canary would stop ticking with nothing to notice it.
    expect(units).toHaveLength(1);
    await expect(Promise.all(units)).resolves.toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("advances the stored canary state, so a failed send still lets the next tick correlate", async () => {
    const { ctx, units } = recordingCtx();
    const { env, store } = envWith();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled!(controller, env, ctx);
    await Promise.all(units);

    // The tick is only useful if it PERSISTED something. A dispatch that ran but wrote nothing would
    // leave the canary permanently unable to correlate, and every tick would look like a fresh start.
    expect(store.size).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});
