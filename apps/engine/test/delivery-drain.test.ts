import type { DueDelivery } from "@webhook-co/db";
import type { DeliverResult, SealedSigningSecret } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  buildDeliverArgs,
  makeDrainDeps,
  runDeliveryDrain,
  type DrainDeps,
  type DrainIo,
} from "../src/delivery-drain";

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

describe("runDeliveryDrain — mid-list ordered break + outcome-metadata propagation", () => {
  it("ordered: a SUCCESSFUL head advances, then a later retrying delivery breaks the rest (FIFO, position-independent)", async () => {
    const d = deps(
      [due({ id: "a" }), due({ id: "b", attempt: 2 }), due({ id: "c" })],
      (x) => (x.id === "b" ? fail(500) : ok()),
      true,
    );
    await runDeliveryDrain(d);
    expect(d.delivers).toEqual(["a", "b"]); // a delivered, b attempted+retried, c NOT attempted
    expect(d.delivered).toEqual([["a", 200]]);
    expect(d.retried.map((r) => r[0])).toEqual(["b"]); // the break fired at b, not by position
  });

  it("propagates the attempt's status + error into recordRetry / recordDead / recordBlocked", async () => {
    const retryMeta: Array<[number | null, string | null]> = [];
    const deadMeta: Array<[number | null, string | null]> = [];
    const blockedMeta: Array<[number | null, string | null]> = [];
    const base = deps([], () => ok());
    const spy: DrainDeps = {
      ...base,
      listDue: async () => [
        due({ id: "r", attempt: 1 }),
        due({ id: "d", attempt: 8 }),
        due({ id: "b" }),
      ],
      deliver: async (x) => (x.id === "r" ? fail(503) : x.id === "d" ? fail(500) : blocked()),
      recordRetry: async (_d, _at, sc, err) => void retryMeta.push([sc, err]),
      recordDead: async (_d, sc, err) => void deadMeta.push([sc, err]),
      recordBlocked: async (_d, sc, err) => void blockedMeta.push([sc, err]),
    };
    await runDeliveryDrain(spy);
    expect(retryMeta).toEqual([[503, "http 503"]]);
    expect(deadMeta).toEqual([[500, "http 500"]]);
    expect(blockedMeta).toEqual([[null, "ssrf"]]);
  });
});

describe("makeDrainDeps — outcome → lifecycle-write mapping (the DO's pure wiring)", () => {
  // Spy I/O capturing exactly what each lifecycle write receives.
  function io(): DrainIo & {
    delivered: unknown[];
    retried: unknown[];
    terminal: unknown[];
  } {
    const delivered: unknown[] = [];
    const retried: unknown[] = [];
    const terminal: unknown[] = [];
    return {
      destinationId: "dest_99",
      listDue: async () => [],
      signingSecrets: async () => [],
      ordered: async () => false,
      deliver: async () => ok(),
      markDelivered: async (a) => void delivered.push(a),
      scheduleRetry: async (a) => void retried.push(a),
      markTerminal: async (a) => void terminal.push(a),
      now: () => NOW,
      delivered,
      retried,
      terminal,
    };
  }

  it("recordRetry advances attempt by EXACTLY 1 and threads the schedule + status/error", async () => {
    const i = io();
    await makeDrainDeps(i).recordRetry(
      due({ id: "x", attempt: 3 }),
      new Date(1234),
      500,
      "http 500",
    );
    expect(i.retried).toEqual([
      { id: "x", nextAttempt: 4, nextRetryAt: new Date(1234), statusCode: 500, error: "http 500" },
    ]);
  });

  it("recordDead → status 'dead', recordBlocked → status 'blocked' (threading the destination + attempt)", async () => {
    const i = io();
    const deps = makeDrainDeps(i);
    await deps.recordDead(due({ id: "x", attempt: 8 }), 503, "exhausted");
    await deps.recordBlocked(due({ id: "y", attempt: 1 }), null, "ssrf");
    expect(i.terminal).toEqual([
      {
        id: "x",
        destinationId: "dest_99",
        status: "dead",
        attempt: 8,
        statusCode: 503,
        error: "exhausted",
      },
      {
        id: "y",
        destinationId: "dest_99",
        status: "blocked",
        attempt: 1,
        statusCode: null,
        error: "ssrf",
      },
    ]);
  });

  it("recordDelivered threads id/destinationId/attempt/statusCode", async () => {
    const i = io();
    await makeDrainDeps(i).recordDelivered(due({ id: "x", attempt: 2 }), 200);
    expect(i.delivered).toEqual([
      { id: "x", destinationId: "dest_99", attempt: 2, statusCode: 200 },
    ]);
  });
});

describe("buildDeliverArgs — stable webhook-id + signing gate", () => {
  const sealed = [{} as SealedSigningSecret];

  it("uses the STABLE delivery row id as webhook-id, regardless of attempt number", () => {
    const a1 = buildDeliverArgs("org", due({ id: "del_42", attempt: 1 }), sealed, 0);
    const a7 = buildDeliverArgs("org", due({ id: "del_42", attempt: 7 }), sealed, 0);
    expect(a1.signing!.webhookId).toBe("del_42");
    expect(a7.signing!.webhookId).toBe("del_42"); // unchanged across retries → receiver dedups
  });

  it("signs ONLY when secrets are present (an unsigned destination builds no signing block → no KMS)", () => {
    expect(buildDeliverArgs("org", due(), [], 0).signing).toBeUndefined();
    expect(buildDeliverArgs("org", due(), sealed, 0).signing).toBeDefined();
  });

  it("threads orgId/endpointId/dedupKey/url/headers and a per-attempt unix-seconds timestamp", () => {
    const d = due({ id: "del_1" });
    const args = buildDeliverArgs("org_x", d, sealed, 5_000);
    expect(args).toMatchObject({
      orgId: "org_x",
      endpointId: d.endpointId,
      dedupKey: d.dedupKey,
      url: d.url,
      headers: d.headers,
    });
    expect(args.signing!.timestamp).toBe(5); // floor(5000ms / 1000) = 5s
    expect(args.signing!.secrets).toBe(sealed);
  });
});
