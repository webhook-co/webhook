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
    eventId: over.eventId ?? "ev_1",
    endpointId: "ep_1",
    payloadR2Key: "org/org_x/ep/ep_1/" + "a".repeat(64),
    headers: [],
    url: "https://d.example.com/in",
    verified: over.verified ?? true,
    deliverable: over.deliverable ?? true,
    sourceDeleted: over.sourceDeleted ?? false,
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
  blockedReasons: [string, string | null][];
  delivers: string[];
  logs: { event: string; fields: Record<string, unknown> }[];
  metrics: { name: string; labels: Record<string, string>; value?: number }[];
} {
  const delivered: [string, number][] = [];
  const retried: [string, number][] = [];
  const dead: string[] = [];
  const blockedRec: string[] = [];
  const blockedReasons: [string, string | null][] = [];
  const delivers: string[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const metrics: { name: string; labels: Record<string, string>; value?: number }[] = [];
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
    recordBlocked: async (d, _sc, error) => {
      blockedRec.push(d.id);
      blockedReasons.push([d.id, error]);
    },
    now: () => NOW,
    log: (event, fields) => void logs.push({ event, fields }),
    metric: (name, labels, value) => void metrics.push({ name, labels, value }),
    delivered,
    retried,
    dead,
    blockedRec,
    blockedReasons,
    delivers,
    logs,
    metrics,
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

  it("a non-deliverable (failed-verification) row is terminally BLOCKED and NEVER POSTed — ADR-0103 defense-in-depth", async () => {
    // The enqueue gate already drops `failed` events, but the drain re-checks per delivery so a pre-gate /
    // backlog row (or any future enqueue path that forgets the gate) is refused HERE, not forwarded.
    const d = deps([due({ id: "a", deliverable: false }), due({ id: "b" })], () => ok());
    await runDeliveryDrain(d);
    expect(d.delivers).toEqual(["b"]); // 'a' is never handed to deliver() — no outbound POST
    expect(d.blockedRec).toEqual(["a"]); // terminally blocked
    expect(d.blockedReasons).toEqual([
      ["a", "verification failed: source signature was checked and rejected"],
    ]);
    expect(d.retried).toEqual([]); // never retried
    expect(d.dead).toEqual([]);
    expect(d.delivered).toEqual([["b", 200]]);
  });

  it("a TOMBSTONED source event is blocked with an ACCURATE reason (not a bogus verification failure)", async () => {
    // deliverable is now overloaded (verification-reject OR source-deleted); the drain must record the real
    // cause so a delivery view doesn't show "signature rejected" for an event the user simply deleted (S3).
    const d = deps([due({ id: "a", deliverable: false, sourceDeleted: true })], () => ok());
    await runDeliveryDrain(d);
    expect(d.delivers).toEqual([]); // never POSTed
    expect(d.blockedReasons).toEqual([["a", "source event was deleted"]]);
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

  it("ordered: a non-deliverable head is terminal (blocked) → newer deliveries proceed", async () => {
    const d = deps([due({ id: "a", deliverable: false }), due({ id: "b" })], () => ok(), true);
    await runDeliveryDrain(d);
    expect(d.blockedRec).toEqual(["a"]); // head refused (never POSTed)…
    expect(d.delivers).toEqual(["b"]); // …and, being terminal, does not block the rest
    expect(d.delivered).toEqual([["b", 200]]);
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

  // The POST latency guardedDeliver already measures (result.latencyMs) must reach the write as duration_ms,
  // so the dashboard's p95 tile has data. It threads through every outcome.
  it("threads durationMs into each lifecycle write", async () => {
    const i = io();
    const deps = makeDrainDeps(i);
    await deps.recordDelivered(due({ id: "a", attempt: 1 }), 200, 42);
    await deps.recordRetry(due({ id: "b", attempt: 1 }), new Date(1), 500, "e", 7);
    await deps.recordDead(due({ id: "c", attempt: 8 }), 500, "e", 99);
    await deps.recordBlocked(due({ id: "d", attempt: 1 }), null, "ssrf", 3);
    expect((i.delivered[0] as { durationMs: number }).durationMs).toBe(42);
    expect((i.retried[0] as { durationMs: number }).durationMs).toBe(7);
    expect((i.terminal[0] as { durationMs: number }).durationMs).toBe(99);
    expect((i.terminal[1] as { durationMs: number }).durationMs).toBe(3);
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

  it("signs ONLY a VERIFIED event — an unverified (unattempted) delivery is UNSIGNED even with secrets (ADR-0103)", () => {
    // We never re-sign (vouch for) an event we didn't authenticate — a forged event can't carry our signature.
    expect(buildDeliverArgs("org", due({ verified: false }), sealed, 0).signing).toBeUndefined();
    expect(buildDeliverArgs("org", due({ verified: true }), sealed, 0).signing).toBeDefined();
  });

  it("threads orgId/endpointId/payloadR2Key/url/headers and a per-attempt unix-seconds timestamp", () => {
    const d = due({ id: "del_1" });
    const args = buildDeliverArgs("org_x", d, sealed, 5_000);
    expect(args).toMatchObject({
      orgId: "org_x",
      endpointId: d.endpointId,
      payloadR2Key: d.payloadR2Key,
      url: d.url,
      headers: d.headers,
    });
    expect(args.signing!.timestamp).toBe(5); // floor(5000ms / 1000) = 5s
    expect(args.signing!.secrets).toBe(sealed);
  });
});

describe("runDeliveryDrain — received→delivered correlation log + RED metrics (Slice 3.5)", () => {
  it("a delivered attempt logs delivery.attempt{eventId, delivered} + emits delivery.attempts{2xx,1} + duration", async () => {
    const d = deps([due({ id: "a", attempt: 1, eventId: "ev_42" })], () => ok(200));
    await runDeliveryDrain(d);
    const log = d.logs.find((l) => l.event === "delivery.attempt");
    expect(log?.fields).toMatchObject({
      eventId: "ev_42",
      deliveryId: "a",
      attempt: 1,
      outcome: "delivered",
      statusCode: 200,
    });
    expect(d.metrics.find((m) => m.name === "delivery.attempts")?.labels).toEqual({
      status_class: "2xx",
      attempt_bucket: "1",
    });
    expect(d.metrics.find((m) => m.name === "delivery.duration_ms")?.labels).toEqual({
      status_class: "2xx",
    });
    expect(d.metrics.find((m) => m.name === "delivery.duration_ms")?.value).toBe(1); // ok() latencyMs = 1
  });

  it("a dead-letter (attempt 8, 500) logs outcome=dead + delivery.attempts{5xx,4-8}, counts NO retry", async () => {
    const d = deps([due({ id: "a", attempt: 8 })], () => fail(500));
    await runDeliveryDrain(d);
    expect(d.logs.find((l) => l.event === "delivery.attempt")?.fields.outcome).toBe("dead");
    const attempts = d.metrics.find((m) => m.name === "delivery.attempts");
    expect(attempts?.labels).toEqual({ status_class: "5xx", attempt_bucket: "4-8" });
    expect(d.metrics.some((m) => m.name === "delivery.retries")).toBe(false); // dead is NOT a retry
  });

  it("a retryable 503 emits delivery.retries{5xx} + delivery.attempts{5xx}, log outcome=retry", async () => {
    const d = deps([due({ id: "a", attempt: 1 })], () => fail(503));
    await runDeliveryDrain(d);
    expect(d.logs.find((l) => l.event === "delivery.attempt")?.fields.outcome).toBe("retry");
    expect(d.metrics.find((m) => m.name === "delivery.attempts")?.labels.status_class).toBe("5xx");
    expect(
      d.metrics.some((m) => m.name === "delivery.retries" && m.labels.status_class === "5xx"),
    ).toBe(true);
  });

  it("an SSRF block emits delivery.attempts{blocked} and counts NO retry", async () => {
    const d = deps([due({ id: "a" })], () => blocked());
    await runDeliveryDrain(d);
    expect(d.logs.find((l) => l.event === "delivery.attempt")?.fields.outcome).toBe("blocked");
    expect(d.metrics.find((m) => m.name === "delivery.attempts")?.labels.status_class).toBe(
      "blocked",
    );
    expect(d.metrics.some((m) => m.name === "delivery.retries")).toBe(false);
  });

  it("a non-deliverable row is refused (no POST) — delivery.attempts{refused}, no duration metric", async () => {
    const d = deps([due({ id: "a", deliverable: false })], () => ok());
    await runDeliveryDrain(d);
    expect(d.logs.find((l) => l.event === "delivery.attempt")?.fields.outcome).toBe("refused");
    expect(d.metrics.find((m) => m.name === "delivery.attempts")?.labels.status_class).toBe(
      "refused",
    );
    expect(d.metrics.some((m) => m.name === "delivery.duration_ms")).toBe(false); // no POST → no latency
  });

  it("attempt 8 buckets into '4-8' (never the raw, unbounded count)", async () => {
    const d = deps([due({ id: "a", attempt: 8 })], () => ok());
    await runDeliveryDrain(d);
    expect(d.metrics.find((m) => m.name === "delivery.attempts")?.labels.attempt_bucket).toBe(
      "4-8",
    );
  });

  it("no delivery metric label is an id/uuid (bounded enums only)", async () => {
    const d = deps([due({ id: "a" })], () => ok());
    await runDeliveryDrain(d);
    for (const m of d.metrics)
      for (const v of Object.values(m.labels)) expect(v).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
