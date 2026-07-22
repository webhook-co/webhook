import { describe, expect, it } from "vitest";

import { KV_STATE_KEY, parseState, receiptKey } from "./canary";
import {
  RECEIPT_TTL_SECONDS,
  readState,
  recordReceipt,
  runCanaryTick,
  type CanaryStore,
} from "./canary-runner";

function memStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const ttls: Record<string, number | undefined> = {};
  const store: CanaryStore = {
    get: async (k) => map.get(k) ?? null,
    put: async (k, v, o) => {
      map.set(k, v);
      ttls[k] = o?.expirationTtl;
    },
  };
  return { store, map, ttls };
}

const deps = (store: CanaryStore, over: Partial<Parameters<typeof runCanaryTick>[0]> = {}) => ({
  store,
  send: async () => {},
  nonce: () => "n-new",
  now: () => 5_000,
  ...over,
});

describe("runCanaryTick", () => {
  it("arms a nonce on the very first tick and records no success yet", async () => {
    const { store, map } = memStore();
    const next = await runCanaryTick(deps(store));
    expect(next.inFlight).toEqual({ nonce: "n-new", sentAt: 5_000 });
    expect(next.lastSuccessAt).toBeNull();
    expect(parseState(map.get(KV_STATE_KEY) ?? null).inFlight?.nonce).toBe("n-new");
  });

  it("correlates the previous nonce's receipt into a success", async () => {
    const { store } = memStore({
      [KV_STATE_KEY]: JSON.stringify({ inFlight: { nonce: "n-old", sentAt: 1_000 } }),
      [receiptKey("n-old")]: "1_400".replace("_", ""),
    });
    const next = await runCanaryTick(deps(store));
    expect(next.lastSuccessAt).toBe(1400);
    expect(next.lastLatencyMs).toBe(400);
  });

  it("does not correlate when the previous nonce never arrived", async () => {
    const { store } = memStore({
      [KV_STATE_KEY]: JSON.stringify({
        inFlight: { nonce: "n-old", sentAt: 1_000 },
        lastSuccessAt: 900,
      }),
    });
    const next = await runCanaryTick(deps(store));
    expect(next.lastSuccessAt).toBe(900); // preserved, so one miss degrades rather than flips
  });

  it("ignores a malformed receipt rather than treating it as a success", async () => {
    const { store } = memStore({
      [KV_STATE_KEY]: JSON.stringify({ inFlight: { nonce: "n-old", sentAt: 1_000 } }),
      [receiptKey("n-old")]: "not-a-number",
    });
    expect((await runCanaryTick(deps(store))).lastSuccessAt).toBeNull();
  });

  // Bailing out on a failed send would leave the OLD nonce armed forever, so a much later receipt
  // could correlate against it and report a healthy pipeline that has been down for hours.
  it("still advances state when the send fails, so staleness proceeds on schedule", async () => {
    const { store, map } = memStore({
      [KV_STATE_KEY]: JSON.stringify({ inFlight: { nonce: "n-old", sentAt: 1_000 } }),
    });
    const next = await runCanaryTick(
      deps(store, {
        send: async () => {
          throw new Error("ingest 503");
        },
      }),
    );
    expect(next.inFlight).toEqual({ nonce: "n-new", sentAt: 5_000 });
    expect(next.lastSuccessAt).toBeNull();
    expect(parseState(map.get(KV_STATE_KEY) ?? null).inFlight?.nonce).toBe("n-new");
  });

  it("a failed send never throws out of the tick", async () => {
    const { store } = memStore();
    await expect(
      runCanaryTick(
        deps(store, {
          send: async () => {
            throw new Error("network");
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("sends the nonce it arms, not the one it correlated", async () => {
    const sent: string[] = [];
    const { store } = memStore({
      [KV_STATE_KEY]: JSON.stringify({ inFlight: { nonce: "n-old", sentAt: 1_000 } }),
    });
    await runCanaryTick(
      deps(store, {
        send: async (n) => void sent.push(n),
      }),
    );
    expect(sent).toEqual(["n-new"]);
  });
});

describe("recordReceipt", () => {
  it("stores the arrival time under the nonce's key", async () => {
    const { store, map } = memStore();
    await recordReceipt(store, "abc", 1234);
    expect(map.get(receiptKey("abc"))).toBe("1234");
  });

  // Receipts must outlive a slow round-trip but must not accumulate without a sweep.
  it("expires receipts well beyond one tick but not indefinitely", async () => {
    const { store, ttls } = memStore();
    await recordReceipt(store, "abc", 1);
    expect(ttls[receiptKey("abc")]).toBe(RECEIPT_TTL_SECONDS);
    expect(RECEIPT_TTL_SECONDS).toBeGreaterThan(15 * 60);
  });
});

describe("readState", () => {
  it("returns empty history for a cold store", async () => {
    const { store } = memStore();
    expect((await readState(store)).lastSuccessAt).toBeNull();
  });
});
