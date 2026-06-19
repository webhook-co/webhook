import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  b64ToBytes,
  encodeCursor,
  importCursorKey,
  readSecretBinding,
  type Cursor,
  type EventSummary,
} from "@webhook-co/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/index";
import { drainPages, type ListenSession } from "../src/listen-session";

// The LISTEN_SESSION DO runs in the real workerd runtime. We drive it with runInDurableObject (to
// inject the tenant-poll seam + inspect storage) and runDurableObjectAlarm (to fire the poll), so the
// tests prove the WIRING — protocol, cursor/ack, resume, fail-safe alarm, idle stop, cross-org
// binding — without a live Postgres. The watermark/keyset correctness itself is proven in the db pool
// (packages/db reads.test.ts). NOTE: a `setAlarm(now)` is immediately due and auto-fires in the pool,
// so EVERY session injects a safe pollEvents before connecting — otherwise the real poll would dial
// the absent local Postgres.
const bindings = env as unknown as Env;

const HDR = {
  ORG: "x-listen-org-id",
  ENDPOINT: "x-listen-endpoint-id",
  SESSION: "x-listen-session-id",
  SINCE: "x-listen-since-cursor",
  SINCE_NOW: "x-listen-since-now",
} as const;

interface Binding {
  orgId: string;
  endpointId: string;
  sessionId: string;
}
type PollFn = (
  binding: Binding,
  resume: Cursor | undefined,
) => Promise<{ events: EventSummary[]; caughtUp: boolean }>;
type MetaFn = (
  orgId: string,
  endpointId: string,
  resume: Cursor | undefined,
) => Promise<{ headCursor: Cursor | null; backlogCount: number }>;
/** The DO with its protected seams exposed for injection (tests aren't typechecked by tsc). */
type Pollable = ListenSession & { pollEvents: PollFn; backlogMeta: MetaFn };
const EMPTY_POLL: PollFn = async () => ({ events: [], caughtUp: true });
/** A benign backlog probe (caught up, nothing behind) so connect emits a harmless status frame. */
const EMPTY_META: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });

let cursorKey: CryptoKey;
beforeAll(async () => {
  // CURSOR_KEY is a SecretsStoreSecret binding in prod; the test env injects a plain string, so
  // readSecretBinding bridges both (matches how the DO reads it).
  cursorKey = await importCursorKey(b64ToBytes(await readSecretBinding(bindings.CURSOR_KEY)));
});

function summaryAt(receivedAt: Date): EventSummary {
  return {
    id: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    endpointId: crypto.randomUUID(),
    receivedAt,
    provider: "stripe",
    dedupKey: `dk_${crypto.randomUUID()}`,
    dedupStrategy: "content_hash",
    verified: true,
  };
}

function stubFor(sessionId: string): DurableObjectStub {
  return bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
}

function newBinding(): Binding {
  return {
    orgId: crypto.randomUUID(),
    endpointId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
  };
}

async function ackCursor(cur: Cursor): Promise<string> {
  return JSON.stringify({ type: "ack", cursor: await encodeCursor(cur, cursorKey) });
}

function connect(
  stub: DurableObjectStub,
  b: Binding,
  opts: { since?: string; sinceNow?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    [HDR.ORG]: b.orgId,
    [HDR.ENDPOINT]: b.endpointId,
    [HDR.SESSION]: b.sessionId,
  };
  if (opts.since) headers[HDR.SINCE] = opts.since;
  if (opts.sinceNow) headers[HDR.SINCE_NOW] = "1";
  return stub.fetch("https://engine.example/listen", { headers });
}

/** The DO with the latest-cursor seam exposed for injection (no live Postgres in the pool). */
type WithLatest = ListenSession & { latestCursor: () => Promise<Cursor | null> };

/** Inject the poll + backlog seams (default empty) THEN connect — so neither connect nor the
 * auto-firing alarm ever hits the absent local PG. */
async function openSession(
  b: Binding,
  poll: PollFn = EMPTY_POLL,
  meta: MetaFn = EMPTY_META,
): Promise<{ stub: DurableObjectStub; res: Response }> {
  const stub = stubFor(b.sessionId);
  await runInDurableObject(stub, (inst) => {
    (inst as Pollable).pollEvents = poll;
    (inst as Pollable).backlogMeta = meta;
  });
  const res = await connect(stub, b);
  return { stub, res };
}

describe("ListenSession — connect + stream", () => {
  it("accepts the WebSocket and streams a ready frame then event frames", async () => {
    const b = newBinding();
    const s1 = summaryAt(new Date("2026-06-10T12:00:00.000Z"));
    const s2 = summaryAt(new Date("2026-06-10T12:00:01.000Z"));
    const { stub, res } = await openSession(b, async () => ({ events: [s1, s2], caughtUp: true }));

    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    const msgs: { type: string; summary?: { id: string }; cursor?: string; sessionId?: string }[] =
      [];
    ws.addEventListener("message", (e) => {
      msgs.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
    });
    ws.accept();

    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(msgs.length).toBeGreaterThanOrEqual(4));

    expect(msgs[0]).toMatchObject({
      type: "ready",
      sessionId: b.sessionId,
      watermarkDeltaMs: 5000,
    });
    // The connect-time cursor-contract status precedes the event frames (ADR-0017).
    expect(msgs[1]).toMatchObject({ type: "status" });
    expect(msgs[2]).toMatchObject({ type: "event", summary: { id: s1.id } });
    expect(msgs[3]).toMatchObject({ type: "event", summary: { id: s2.id } });
    expect(typeof msgs[2].cursor).toBe("string");

    const count = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    expect(count).toBe(1);
  });
});

describe("ListenSession — ?since=now", () => {
  it("seeds the durable cursor from the current position on a new session", async () => {
    const b = newBinding();
    const latest: Cursor = {
      receivedAt: new Date("2026-06-10T12:00:09.000Z"),
      id: crypto.randomUUID(),
    };
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithLatest).latestCursor = async () => latest;
    });
    const res = await connect(stub, b, { sinceNow: true });

    expect(res.status).toBe(101);
    // The cursor is seeded to the current position, so the first poll tails only NEW events.
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      receivedAtMs: latest.receivedAt.getTime(),
      id: latest.id,
    });
  });

  it("leaves the cursor unset when the endpoint has no events (empty → oldest == now)", async () => {
    const b = newBinding();
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithLatest).latestCursor = async () => null;
    });
    await connect(stub, b, { sinceNow: true });

    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();
  });
});

describe("ListenSession — cursor + at-least-once", () => {
  it("persists the durable resume cursor only on ack", async () => {
    const b = newBinding();
    const { stub } = await openSession(b);

    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();

    const c: Cursor = { receivedAt: new Date("2026-06-10T12:00:02.000Z"), id: crypto.randomUUID() };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });

    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      receivedAtMs: c.receivedAt.getTime(),
      id: c.id,
    });
  });

  it("after reconnect, resumes the poll from the acked cursor with the bound org (never a client value)", async () => {
    const b = newBinding();
    const calls: { orgId: string; endpointId: string; resume: Cursor | undefined }[] = [];
    const { stub } = await openSession(b, async (binding, resume) => {
      calls.push({ orgId: binding.orgId, endpointId: binding.endpointId, resume });
      return { events: [], caughtUp: true };
    });

    const c: Cursor = { receivedAt: new Date("2026-06-10T12:00:05.000Z"), id: crypto.randomUUID() };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });
    await connect(stub, b); // reconnect → resets in-memory lastSent
    await runDurableObjectAlarm(stub);

    const last = calls.at(-1);
    expect(last?.orgId).toBe(b.orgId);
    expect(last?.endpointId).toBe(b.endpointId);
    expect(last?.resume).toEqual(c);
  });

  it("rejects a tampered ack cursor without advancing the durable cursor", async () => {
    const b = newBinding();
    const { stub } = await openSession(b);
    await runInDurableObject(stub, async (inst, state) => {
      const bad = JSON.stringify({ type: "ack", cursor: "not-a-valid-signed-cursor" });
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], bad);
    });
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();
  });
});

describe("ListenSession — fail-safe alarm + idle", () => {
  it("never throws on a poll error: re-arms the alarm (POLL_DEGRADED, not silence)", async () => {
    const b = newBinding();
    const { stub } = await openSession(b, async () => {
      throw new Error("neon unavailable");
    });

    const ran = await runDurableObjectAlarm(stub); // must not throw
    expect(ran).toBe(true);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();
  });

  it("stops polling once the last socket closes", async () => {
    const b = newBinding();
    const { stub } = await openSession(b);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).not.toBeNull();

    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketClose(state.getWebSockets()[0], 1000, "", true);
    });
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });
});

describe("ListenSession — session pinning", () => {
  it("refuses a reconnect that rebinds the session to a different endpoint or org (403)", async () => {
    const b = newBinding();
    const { stub } = await openSession(b); // pins (orgId, endpointId, sessionId)

    // Same sessionId, different endpoint → refused (a reused id can't be repointed).
    expect((await connect(stub, { ...b, endpointId: crypto.randomUUID() })).status).toBe(403);
    // Same sessionId, different org (a stolen id presented under another bearer) → refused.
    expect((await connect(stub, { ...b, orgId: crypto.randomUUID() })).status).toBe(403);
    // The legitimate same-binding reconnect still upgrades.
    expect((await connect(stub, b)).status).toBe(101);
  });
});

describe("drainPages — bounded multi-page catch-up", () => {
  const at = (s: string): Date => new Date(`2026-06-10T12:00:0${s}.000Z`);
  const cur = (id: string): Cursor => ({ receivedAt: at("0"), id });

  it("drains across pages, threading each nextCursor as the next resume, until exhausted", async () => {
    const pages = [
      { items: [summaryAt(at("0"))], nextCursor: cur("a") },
      { items: [summaryAt(at("1"))], nextCursor: cur("b") },
      { items: [summaryAt(at("2"))], nextCursor: null },
    ];
    const seen: (Cursor | undefined)[] = [];
    let i = 0;
    const out = await drainPages((resume) => {
      seen.push(resume);
      return Promise.resolve(pages[i++]);
    }, undefined);

    expect(out.events).toHaveLength(3); // every page's items
    expect(out.caughtUp).toBe(true); // a page returned a null nextCursor → reached the head
    expect(i).toBe(3); // stopped after the page whose nextCursor was null
    expect(seen).toEqual([undefined, cur("a"), cur("b")]); // resume threaded forward
  });

  it("stops at the maxPages cap even when more pages remain", async () => {
    let calls = 0;
    const out = await drainPages(
      () => {
        calls++;
        return Promise.resolve({ items: [summaryAt(at("0"))], nextCursor: cur("more") });
      },
      undefined,
      3,
    );
    expect(calls).toBe(3); // capped — did not loop forever on a never-null nextCursor
    expect(out.events).toHaveLength(3);
    expect(out.caughtUp).toBe(false); // hit maxPages with a backlog still pending — NOT caught up
  });
});

describe("ListenSession — cursor-contract status frame (B1b, ADR-0017)", () => {
  // Collect only status frames off a freshly-accepted socket.
  async function statusesOf(
    res: Response,
  ): Promise<{ ws: WebSocket; statuses: { caughtUp: boolean; lag?: { backlogCount: number } }[] }> {
    const ws = res.webSocket as WebSocket;
    const statuses: { caughtUp: boolean; lag?: { backlogCount: number } }[] = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (m.type === "status") statuses.push(m);
    });
    ws.accept();
    return { ws, statuses };
  }

  it("emits a connect status with the initial caughtUp:false + the capped backlog lag (first bind)", async () => {
    const b = newBinding();
    const head: Cursor = {
      receivedAt: new Date("2026-06-10T12:00:00.000Z"),
      id: crypto.randomUUID(),
    };
    const { res } = await openSession(b, EMPTY_POLL, async () => ({
      headCursor: head,
      backlogCount: 7,
    }));
    const msgs: {
      type: string;
      caughtUp?: boolean;
      lag?: { backlogCount: number; headLagMs?: number };
    }[] = [];
    const ws = res.webSocket as WebSocket;
    ws.addEventListener("message", (e) =>
      msgs.push(JSON.parse(typeof e.data === "string" ? e.data : "")),
    );
    ws.accept();
    await vi.waitFor(() => expect(msgs.length).toBeGreaterThanOrEqual(2));
    expect(msgs[0]).toMatchObject({ type: "ready" });
    expect(msgs[1]).toMatchObject({ type: "status", caughtUp: false, lag: { backlogCount: 7 } });
    expect(typeof msgs[1].lag?.headLagMs).toBe("number"); // head present → advisory delta included
    expect(msgs[1].lag?.headLagMs).toBeGreaterThanOrEqual(0);
  });

  it("reports caughtUp at connect when the backlog is empty (lag 0, no headLagMs)", async () => {
    const b = newBinding();
    const { res } = await openSession(b, EMPTY_POLL, async () => ({
      headCursor: null,
      backlogCount: 0,
    }));
    const { statuses } = await statusesOf(res);
    await vi.waitFor(() => expect(statuses.length).toBeGreaterThanOrEqual(1));
    expect(statuses[0]).toMatchObject({ caughtUp: true, lag: { backlogCount: 0 } });
  });

  it("stays fail-safe when the connect backlog probe errors (still 101, no connect status)", async () => {
    const b = newBinding();
    // backlogMeta throws (a DB hiccup) → the connect status is skipped (wasCaughtUp left unlatched) but
    // the upgrade still 101s; the inline poll's caught-up state then drives the transition status.
    const { res } = await openSession(b, EMPTY_POLL, async () => {
      throw new Error("neon unavailable");
    });
    expect(res.status).toBe(101);
    const { statuses } = await statusesOf(res);
    // No connect frame (probe failed); the inline EMPTY_POLL (caughtUp:true) fires the transition once.
    await vi.waitFor(() => expect(statuses.length).toBe(1));
    expect(statuses[0]).toMatchObject({ caughtUp: true });
  });

  it("emits a single caught-up status on the behind→caught-up transition, not every poll", async () => {
    const b = newBinding();
    // Connect behind (backlog 1); inline connect-poll is still behind; the next alarm catches up;
    // a further alarm must NOT re-emit (the latch holds until a not-caught-up poll un-latches it).
    let pollNo = 0;
    const poll: PollFn = async () => {
      pollNo += 1;
      return pollNo === 1
        ? { events: [summaryAt(new Date("2026-06-10T12:00:00.000Z"))], caughtUp: false }
        : { events: [], caughtUp: true };
    };
    const { stub, res } = await openSession(b, poll, async () => ({
      headCursor: null,
      backlogCount: 1,
    }));
    const { statuses } = await statusesOf(res);
    // connect status (caughtUp:false). The inline connect-poll (#1) is still behind → no transition.
    await vi.waitFor(() => expect(statuses.length).toBeGreaterThanOrEqual(1));
    expect(statuses[0]).toMatchObject({ caughtUp: false, lag: { backlogCount: 1 } });

    await runDurableObjectAlarm(stub); // poll #2 → caught up → ONE transition status
    await vi.waitFor(() => expect(statuses.length).toBe(2));
    expect(statuses[1]).toMatchObject({ caughtUp: true });

    await runDurableObjectAlarm(stub); // poll #3 → still caught up → NO new status (no spam)
    await runDurableObjectAlarm(stub);
    expect(statuses).toHaveLength(2);
  });
});
