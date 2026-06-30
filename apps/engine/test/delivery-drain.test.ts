import type { DueDelivery } from "@webhook-co/db";
import type { DeliverResult } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { runDeliveryDrain, type DrainDeps } from "../src/delivery-drain";

// The PURE drain orchestration (S3 Slice 3): FIFO order, the strict-ordered head-of-line gate, and the
// retry/dead-letter scheduling decisions — driven entirely by fakes, no workerd / Postgres / R2 / KMS.

const NOW = 1_000_000;
function due(over: Partial<DueDelivery> = {}): DueDelivery {
  return {
    id: over.id ?? "del_1",
    attempt: over.attempt ?? 1,
    eventId: "ev_1",
    endpointId: "ep_1",
    dedupKey: "dk_1",
    headers: [],
    url: "https://d.example.com/in",
  };
}
const ok = (status = 200): DeliverResult => ({
  outcome: "delivered",
  status,
  error: null,
  latencyMs: 1,
});
const fail = (status: number | null = 500): DeliverResult => ({
  outcome: "failed",
  status,
  error: status ? `http ${status}` : "conn",
  latencyMs: 1,
});
const blocked = (): DeliverResult => ({
  outcome: "blocked",
  status: null,
  error: "ssrf",
  latencyMs: 0,
});

function deps(
  list: DueDelivery[],
  deliver: (d: DueDelivery) => DeliverResult,
  ordered = false,
): DrainDeps & {
  delivered: [string, number][];
  retried: [string, number][];
  dead: string[];
  blockedRec: string[];
  delivers: string[];
} {
  const delivered: [string, number][] = [];
  const retried: [string, number][] = [];
  const dead: string[] = [];
  const blockedRec: string[] = [];
  const delivers: string[] = [];
  return {
    listDue: async () => list,
    signingSecrets: async () => [],
    ordered: async () => ordered,
    deliver: async (d) => {
      delivers.push(d.id);
      return deliver(d);
    },
    recordDelivered: async (d, sc) => void delivered.push([d.id, sc]),
    recordRetry: async (d, at) => void retried.push([d.id, at.getTime()]),
    recordDead: async (d) => void dead.push(d.id),
    recordBlocked: async (d) => void blockedRec.push(d.id),
    now: () => NOW,
    delivered,
    retried,
    dead,
    blockedRec,
    delivers,
  };
}

describe("runDeliveryDrain — best-effort (default)", () => {
  it("delivers every due delivery in FIFO order; a 2xx records delivered", async () => {
    const d = deps([due({ id: "a" }), due({ id: "b" }), due({ id: "c" })], () => ok(201));
    await runDeliveryDrain(d);
    expect(d.delivers).toEqual(["a", "b", "c"]);
    expect(d.delivered).toEqual([
      ["a", 201],
      ["b", 201],
      ["c", 201],
    ]);
  });

  it("a retryable failure (attempt 1) schedules the next attempt ~5s out (±jitter) and does NOT block newer ones", async () => {
    const d = deps([due({ id: "a", attempt: 1 }), due({ id: "b" })], (x) =>
      x.id === "a" ? fail(500) : ok(),
    );
    await runDeliveryDrain(d);
    expect(d.retried).toHaveLength(1);
    expect(d.retried[0]![0]).toBe("a");
    // schedule[attempt 1] = 5s ±10% jitter (the exact curve + jitter are pinned in delivery-retry.test.ts).
    expect(d.retried[0]![1]).toBeGreaterThanOrEqual(NOW + 5_000 * 0.9);
    expect(d.retried[0]![1]).toBeLessThanOrEqual(NOW + 5_000 * 1.1);
    expect(d.delivered).toEqual([["b", 200]]); // b still delivered — best-effort doesn't block
    expect(d.delivers).toEqual(["a", "b"]);
  });

  it("dead-letters once the schedule is exhausted (a failure on attempt 8)", async () => {
    const d = deps([due({ id: "a", attempt: 8 })], () => fail(503));
    await runDeliveryDrain(d);
    expect(d.dead).toEqual(["a"]);
    expect(d.retried).toEqual([]);
  });

  it("a blocked (SSRF refusal) is terminal — recorded blocked, never retried", async () => {
    const d = deps([due({ id: "a" })], () => blocked());
    await runDeliveryDrain(d);
    expect(d.blockedRec).toEqual(["a"]);
    expect(d.retried).toEqual([]);
    expect(d.dead).toEqual([]);
  });
});

describe("runDeliveryDrain — strict ordered (head-of-line)", () => {
  it("a retrying head BLOCKS newer deliveries this drain (they are not even attempted)", async () => {
    const d = deps(
      [due({ id: "a", attempt: 2 }), due({ id: "b" }), due({ id: "c" })],
      (x) => (x.id === "a" ? fail(500) : ok()),
      true,
    );
    await runDeliveryDrain(d);
    expect(d.delivers).toEqual(["a"]); // stopped after the head's retry — b, c never attempted
    expect(d.retried).toHaveLength(1);
    expect(d.retried[0]![1]).toBeGreaterThanOrEqual(NOW + 5 * 60_000 * 0.9); // schedule[attempt 2] = 5m ±jitter
    expect(d.retried[0]![1]).toBeLessThanOrEqual(NOW + 5 * 60_000 * 1.1);
    expect(d.delivered).toEqual([]);
  });

  it("a terminal head (delivered / dead / blocked) lets newer deliveries proceed", async () => {
    const delv = deps([due({ id: "a" }), due({ id: "b" })], () => ok(), true);
    await runDeliveryDrain(delv);
    expect(delv.delivers).toEqual(["a", "b"]); // head delivered → advance

    const deadHead = deps(
      [due({ id: "a", attempt: 8 }), due({ id: "b" })],
      (x) => (x.id === "a" ? fail() : ok()),
      true,
    );
    await runDeliveryDrain(deadHead);
    expect(deadHead.dead).toEqual(["a"]);
    expect(deadHead.delivers).toEqual(["a", "b"]); // dead head is terminal → advance
  });
});
