import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import {
  advance,
  deliveryChecks,
  deliveryStatus,
  EMPTY_STATE,
  parseState,
  receiptKey,
  STALE_AFTER_MS,
  type CanaryState,
} from "./canary";

const state = (over: Partial<CanaryState> = {}): CanaryState => ({ ...EMPTY_STATE, ...over });

describe("deliveryStatus", () => {
  it("passes while the last round-trip is recent", () => {
    expect(deliveryStatus(state({ lastSuccessAt: 1000 }), 1000 + STALE_AFTER_MS)).toBe("pass");
  });

  it("fails once the last round-trip goes stale", () => {
    expect(deliveryStatus(state({ lastSuccessAt: 1000 }), 1001 + STALE_AFTER_MS)).toBe("fail");
  });

  // Same reasoning as a never-seen heartbeat: no evidence must not render as healthy.
  it("fails when no round-trip has ever completed", () => {
    expect(deliveryStatus(EMPTY_STATE, 10 ** 12)).toBe("fail");
  });

  // Three ticks of tolerance. One missed round-trip is a blip; reporting an outage on it would
  // train everyone to ignore the page.
  it("tolerates roughly three missed five-minute ticks before failing", () => {
    expect(STALE_AFTER_MS).toBe(15 * 60 * 1000);
    const lastSuccessAt = 0;
    expect(deliveryStatus(state({ lastSuccessAt }), 10 * 60 * 1000)).toBe("pass");
    expect(deliveryStatus(state({ lastSuccessAt }), 16 * 60 * 1000)).toBe("fail");
  });
});

describe("advance", () => {
  it("records a success and its latency when the previous nonce came back", () => {
    const prev = state({ inFlight: { nonce: "n1", sentAt: 1000 } });
    const next = advance(prev, { receiptAt: 1400, newNonce: "n2", now: 2000 });
    expect(next.lastSuccessAt).toBe(1400);
    expect(next.lastLatencyMs).toBe(400);
    expect(next.inFlight).toEqual({ nonce: "n2", sentAt: 2000 });
  });

  // A single miss must degrade toward the threshold, not flip the component red instantly.
  it("keeps the previous success when a round-trip is missed", () => {
    const prev = state({
      inFlight: { nonce: "n1", sentAt: 1000 },
      lastSuccessAt: 500,
      lastLatencyMs: 42,
    });
    const next = advance(prev, { receiptAt: null, newNonce: "n2", now: 2000 });
    expect(next.lastSuccessAt).toBe(500);
    expect(next.lastLatencyMs).toBe(42);
    expect(next.inFlight).toEqual({ nonce: "n2", sentAt: 2000 });
  });

  it("cannot correlate on the very first tick, when nothing was in flight", () => {
    const next = advance(EMPTY_STATE, { receiptAt: 1400, newNonce: "n1", now: 1000 });
    expect(next.lastSuccessAt).toBeNull();
    expect(next.inFlight).toEqual({ nonce: "n1", sentAt: 1000 });
  });

  // Clock skew between the sink's write and the tick's read must not produce a negative duration.
  it("never reports a negative latency", () => {
    const prev = state({ inFlight: { nonce: "n1", sentAt: 2000 } });
    expect(advance(prev, { receiptAt: 1900, newNonce: "n2", now: 3000 }).lastLatencyMs).toBe(0);
  });

  it("always arms a new nonce, so a tick can never leave the canary idle", () => {
    for (const receiptAt of [null, 1400]) {
      const next = advance(state({ inFlight: { nonce: "old", sentAt: 1000 } }), {
        receiptAt,
        newNonce: "fresh",
        now: 2000,
      });
      expect(next.inFlight?.nonce).toBe("fresh");
    }
  });
});

describe("parseState", () => {
  it("round-trips a full state", () => {
    const s = state({ inFlight: { nonce: "n", sentAt: 1 }, lastSuccessAt: 2, lastLatencyMs: 3 });
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });

  // Corrupt state must read as "no history" — which is `fail` — never as a crash and never as healthy.
  it.each([
    ["absent", null],
    ["not json", "}{"],
    ["not an object", '"x"'],
    ["null", "null"],
    ["a non-string nonce", '{"inFlight":{"nonce":5,"sentAt":1}}'],
    ["a nonce with no timestamp", '{"inFlight":{"nonce":"n"}}'],
    ["an empty nonce", '{"inFlight":{"nonce":"","sentAt":1}}'],
  ])("treats %s as no history", (_label, raw) => {
    const parsed = parseState(raw as string | null);
    expect(parsed.inFlight).toBeNull();
    expect(deliveryStatus(parsed, 0)).toBe("fail");
  });

  it("keeps a valid last success even when the in-flight record is corrupt", () => {
    const parsed = parseState('{"inFlight":{"nonce":5},"lastSuccessAt":900}');
    expect(parsed.inFlight).toBeNull();
    expect(parsed.lastSuccessAt).toBe(900);
  });
});

describe("deliveryChecks", () => {
  it("passes on a fresh success and fails on a stale one", async () => {
    const fresh = await runChecks(
      deliveryChecks(
        async () => state({ lastSuccessAt: 1000 }),
        () => 1000,
      ),
      { timeoutMs: 500 },
    );
    expect(fresh[0]).toMatchObject({ name: "delivery", status: "pass" });

    const stale = await runChecks(
      deliveryChecks(
        async () => state({ lastSuccessAt: 0 }),
        () => 10 ** 9,
      ),
      { timeoutMs: 500 },
    );
    expect(stale[0]?.status).toBe("fail");
  });

  it("fails rather than throwing when the state store is unreachable", async () => {
    const outcomes = await runChecks(
      deliveryChecks(async () => {
        throw new Error("KV down");
      }),
      { timeoutMs: 500 },
    );
    expect(outcomes[0]?.status).toBe("fail");
  });
});

describe("receiptKey", () => {
  it("namespaces receipts so they cannot collide with the state key or a beat", () => {
    expect(receiptKey("abc")).toBe("canary:receipt:abc");
    expect(receiptKey("abc")).not.toContain("beat:");
  });
});
