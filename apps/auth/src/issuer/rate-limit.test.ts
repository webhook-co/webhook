import { describe, expect, it } from "vitest";

import { consumeRateLimit, type RateLimitDeps, type RateLimitKv } from "./rate-limit";

// A4c-1 — the durable fixed-window rate limiter over KV. Tested against an in-memory fake KV with an
// injected clock (the window math + the TTL passed to put are asserted directly).

function fakeKv(): RateLimitKv & { store: Map<string, string>; lastTtl: number | null } {
  const self = {
    store: new Map<string, string>(),
    lastTtl: null as number | null,
    get: async (k: string) => self.store.get(k) ?? null,
    put: async (k: string, v: string, opts: { expirationTtl: number }) => {
      self.lastTtl = opts.expirationTtl;
      self.store.set(k, v);
    },
  };
  return self;
}

function deps(kv: RateLimitKv, now: number): RateLimitDeps {
  return { kv, nowSeconds: () => now };
}

const RULE = { limit: 3, windowSeconds: 60 };

describe("consumeRateLimit", () => {
  it("allows attempts under the limit, decrementing the remaining budget", async () => {
    const kv = fakeKv();
    // window index = floor(1000/60) = 16 → window end = 17*60 = 1020.
    const a = await consumeRateLimit(deps(kv, 1_000), "ip:1.2.3.4", RULE);
    const b = await consumeRateLimit(deps(kv, 1_001), "ip:1.2.3.4", RULE);
    const c = await consumeRateLimit(deps(kv, 1_002), "ip:1.2.3.4", RULE);
    expect(a).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0, resetSeconds: 20 });
    expect(b).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0, resetSeconds: 19 });
    expect(c).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0, resetSeconds: 18 });
  });

  it("denies once the limit is reached, with a retry-after to the window end", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 3; i++) await consumeRateLimit(deps(kv, 1_000), "b", RULE);
    const denied = await consumeRateLimit(deps(kv, 1_005), "b", RULE);
    expect(denied).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1_020 - 1_005,
      resetSeconds: 1_020 - 1_005,
    });
  });

  it("resets when the window rolls over", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 3; i++) await consumeRateLimit(deps(kv, 1_000), "b", RULE);
    expect((await consumeRateLimit(deps(kv, 1_000), "b", RULE)).allowed).toBe(false);
    // advance into the next window (>= 1020) — a fresh counter.
    const next = await consumeRateLimit(deps(kv, 1_020), "b", RULE);
    expect(next).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0, resetSeconds: 60 });
  });

  it("tracks distinct buckets independently", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 3; i++) await consumeRateLimit(deps(kv, 1_000), "ip:a", RULE);
    expect((await consumeRateLimit(deps(kv, 1_000), "ip:a", RULE)).allowed).toBe(false);
    expect((await consumeRateLimit(deps(kv, 1_000), "ip:b", RULE)).allowed).toBe(true);
  });

  it("writes a TTL covering the window (+buffer), clamped to KV's 60s minimum", async () => {
    const kv = fakeKv();
    await consumeRateLimit(deps(kv, 1_000), "b", { limit: 3, windowSeconds: 600 });
    expect(kv.lastTtl).toBe(605); // 600 + 5
    await consumeRateLimit(deps(kv, 1_000), "c", { limit: 3, windowSeconds: 30 });
    expect(kv.lastTtl).toBe(60); // clamped up from 35 so the put can't be rejected by KV
  });

  it("treats a malformed stored counter as zero (fails open to one allowed, not a crash)", async () => {
    const kv = fakeKv();
    const d = deps(kv, 1_000);
    await consumeRateLimit(d, "b", RULE);
    for (const k of kv.store.keys()) kv.store.set(k, "not-a-number");
    const r = await consumeRateLimit(d, "b", RULE);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("hashes the bucket into the key (raw bucket value never stored as a key)", async () => {
    const kv = fakeKv();
    await consumeRateLimit(deps(kv, 1_000), "ip:203.0.113.7", RULE);
    const keys = [...kv.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^rl:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain("203.0.113.7");
  });
});
