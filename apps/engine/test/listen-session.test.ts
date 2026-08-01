import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  b64ToBytes,
  decodeCursor,
  encodeCursor,
  importCursorKey,
  readSecretBinding,
  WATERMARK_DELTA_MS,
  type Cursor,
  type EventSummary,
} from "@webhook-co/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ItemWithCursor } from "@webhook-co/db";

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
  SCOPE: "x-listen-scope",
  SESSION: "x-listen-session-id",
  USER: "x-listen-user-id",
  SINCE: "x-listen-since-cursor",
  SINCE_SPEC: "x-listen-since-spec",
} as const;

interface Binding {
  orgId: string;
  scope: "org" | "endpoint";
  endpointId?: string; // present iff scope === "endpoint"
  sessionId: string;
  userId?: string;
}
type PollFn = (
  binding: Binding,
  resume: Cursor | undefined,
) => Promise<{ events: ItemWithCursor<EventSummary>[]; caughtUp: boolean }>;
type MetaFn = (
  binding: Pick<Binding, "orgId" | "scope" | "endpointId">,
  resume: Cursor | undefined,
) => Promise<{ headCursor: Cursor | null; backlogCount: number }>;
/** The DO with its protected seams exposed for injection (tests aren't typechecked by tsc). */
type Pollable = ListenSession & {
  pollEvents: PollFn;
  backlogMeta: MetaFn;
  checkStillMember: (binding: Binding) => Promise<boolean>;
};
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

/** The UTC ISO-µs order key SQL would project for a given instant (ms Date → `.mmm000Z` at µs precision). */
const orderKeyOf = (d: Date): string => `${d.toISOString().slice(0, -1)}000Z`;

/** A poll item as the read returns it: the summary paired with its EXACT-µs keyset cursor. */
function itemAt(receivedAt: Date): ItemWithCursor<EventSummary> {
  const item = summaryAt(receivedAt);
  return { item, cursor: { orderKey: orderKeyOf(receivedAt), id: item.id } };
}

function stubFor(sessionId: string): DurableObjectStub {
  return bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
}

function newBinding(over: Partial<Binding> = {}): Binding {
  return {
    orgId: crypto.randomUUID(),
    scope: "endpoint",
    endpointId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    ...over,
  };
}

/** An org-scoped binding: whole-org tail, no endpoint. */
function newOrgBinding(over: Partial<Binding> = {}): Binding {
  return {
    orgId: crypto.randomUUID(),
    scope: "org",
    sessionId: crypto.randomUUID(),
    ...over,
  };
}

async function ackCursor(cur: Cursor): Promise<string> {
  return JSON.stringify({ type: "ack", cursor: await encodeCursor(cur, cursorKey) });
}

/**
 * Every session opened by a test, retained until that test ends. **Load-bearing, not bookkeeping.**
 *
 * `connect` returns a Response carrying the CLIENT end of the WebSocketPair. In production that end is
 * held by a real remote peer for the life of the session. A test that destructures only `{ stub }` drops
 * it unreferenced, and workerd is then free to collect it — which tears the pair down, fires
 * `webSocketClose` on the DO, and `stopIfIdle` deletes the alarm. `getAlarm()` then reads null for a
 * reason that has nothing whatsoever to do with the code under test.
 *
 * That is the "expected null not to be null" failure seen once in CI on 2026-07-29 and never reproduced
 * on an idle laptop — it is a GC race, so it needs a busy machine. Measured directly, connecting and
 * firing the alarm under heap churn:
 *
 *     client end dropped   → 25 nulls in 200 runs (12.5%), socket already gone before the alarm
 *     Response retained    →  0 nulls in 300 runs
 *
 * Retaining the Response is what a real peer does for us. `afterEach` releases them so a long file does
 * not pile up live sessions.
 */
const liveSessions: Response[] = [];
afterEach(() => {
  liveSessions.length = 0;
});

async function connect(
  stub: DurableObjectStub,
  b: Binding,
  opts: { since?: string; sinceSpec?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    [HDR.ORG]: b.orgId,
    [HDR.SCOPE]: b.scope,
    [HDR.SESSION]: b.sessionId,
  };
  if (b.scope === "endpoint" && b.endpointId) headers[HDR.ENDPOINT] = b.endpointId;
  if (b.userId) headers[HDR.USER] = b.userId;
  if (opts.since) headers[HDR.SINCE] = opts.since;
  if (opts.sinceSpec) headers[HDR.SINCE_SPEC] = opts.sinceSpec;
  const res = await stub.fetch("https://engine.example/listen", { headers });
  // Retain BEFORE returning: a caller that ignores the Response must still not lose the socket.
  if (res.webSocket) liveSessions.push(res);
  return res;
}

/** The DO with the --since resolver seam exposed for injection (no live Postgres in the pool). */
type WithResolve = ListenSession & {
  resolveSinceCursor: (orgId: string, since: { kind: string }) => Promise<Cursor | undefined>;
};

/** Inject the poll + backlog seams (default empty) THEN connect — so neither connect nor the
 * auto-firing alarm ever hits the absent local PG. */
async function openSession(
  b: Binding,
  poll: PollFn = EMPTY_POLL,
  meta: MetaFn = EMPTY_META,
  stillMember: (binding: Binding) => Promise<boolean> = async () => true,
): Promise<{ stub: DurableObjectStub; res: Response }> {
  const stub = stubFor(b.sessionId);
  await runInDurableObject(stub, (inst) => {
    (inst as Pollable).pollEvents = poll;
    (inst as Pollable).backlogMeta = meta;
    (inst as Pollable).checkStillMember = stillMember;
  });
  const res = await connect(stub, b);
  return { stub, res };
}

/**
 * The alarm AND the live socket count, read in ONE durable-object call.
 *
 * These are read together because they are the two halves of the same question. `alarm()` early-returns
 * WITHOUT re-arming when `ctx.getWebSockets()` is empty — so a bare `getAlarm()` that comes back null has
 * two very different explanations ("the loop correctly stopped" vs "the socket vanished underneath us"),
 * and a bare `.not.toBeNull()` cannot tell them apart.
 *
 * That distinction is what identified the 2026-07-29 CI flake: every null came with a socket count of
 * ZERO, which ruled out anything happening inside `alarm()` and pinned it to the client end being
 * collected — see `liveSessions`. The count stays reported because it is the discriminator: a future
 * null with `sockets: 1` would be a genuinely different bug, in the poll loop rather than the harness.
 */
async function alarmState(
  stub: DurableObjectStub,
): Promise<{ alarm: number | null; sockets: number }> {
  return runInDurableObject(stub, async (_i, s) => ({
    alarm: await s.storage.getAlarm(),
    sockets: s.getWebSockets().length,
  }));
}

/** `getAlarm()` must be armed — and say what the socket count was if it is not. */
async function expectArmed(stub: DurableObjectStub, why: string): Promise<void> {
  const { alarm, sockets } = await alarmState(stub);
  expect(alarm, `${why} — alarm not armed (live sockets: ${sockets})`).not.toBeNull();
}

describe("ListenSession — connect + stream", () => {
  it("accepts the WebSocket and streams a ready frame then event frames", async () => {
    const b = newBinding();
    const i1 = itemAt(new Date("2026-06-10T12:00:00.000Z"));
    const i2 = itemAt(new Date("2026-06-10T12:00:01.000Z"));
    const { stub, res } = await openSession(b, async () => ({ events: [i1, i2], caughtUp: true }));

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
      watermarkDeltaMs: WATERMARK_DELTA_MS,
    });
    // The connect-time cursor-contract status precedes the event frames (ADR-0017).
    expect(msgs[1]).toMatchObject({ type: "status" });
    expect(msgs[2]).toMatchObject({ type: "event", summary: { id: i1.item.id } });
    expect(msgs[3]).toMatchObject({ type: "event", summary: { id: i2.item.id } });
    expect(typeof msgs[2].cursor).toBe("string");

    const count = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    expect(count).toBe(1);
  });
});

describe("ListenSession — ?since=<grammar> seed (first bind, server-resolved)", () => {
  it("seeds the durable cursor from the resolved boundary, re-parsing the trusted spec", async () => {
    const b = newBinding();
    const resolved: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:09.000Z")),
      id: crypto.randomUUID(),
    };
    const seen: { kind: string }[] = [];
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithResolve).resolveSinceCursor = async (_o, since) => {
        seen.push(since);
        return resolved;
      };
    });
    const res = await connect(stub, b, { sinceSpec: "2h" });

    expect(res.status).toBe(101);
    // The DO re-parses the trusted spec itself (it is authoritative), then resolves it to the boundary
    // cursor, so the first poll tails only from there.
    expect(seen).toEqual([{ kind: "relative", ms: 7_200_000 }]);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      orderKey: resolved.orderKey,
      id: resolved.id,
    });
  });

  it("leaves the cursor unset when resolution yields undefined (beginning / clamp → oldest)", async () => {
    const b = newBinding();
    const seen: { kind: string }[] = [];
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithResolve).resolveSinceCursor = async (_o, since) => {
        seen.push(since);
        return undefined;
      };
    });
    const res = await connect(stub, b, { sinceSpec: "beginning" });

    expect(res.status).toBe(101);
    expect(seen).toEqual([{ kind: "beginning" }]); // the resolver WAS consulted
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();
  });

  it("FAILS the upgrade (503) and binds NOTHING when --since resolution throws (no oldest-flood)", async () => {
    // The seed is LOAD-BEARING (unlike the advisory connect-status probe): a resolution error must fail
    // closed so the CLI retries — NEVER fall through to an unset cursor, which would flood a `--since
    // now` session with the entire backlog. The binding is persisted only AFTER a successful resolve,
    // so nothing is left behind and the retry re-enters a fresh first bind.
    const b = newBinding();
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithResolve).resolveSinceCursor = async () => {
        throw new Error("neon unavailable");
      };
    });
    const res = await connect(stub, b, { sinceSpec: "now" });

    expect(res.status).toBe(503);
    expect(res.webSocket).toBeFalsy();
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("binding"))).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();
  });

  it("ignores --since on RECONNECT — resumes from the acked cursor (first-bind only, R12)", async () => {
    const b = newBinding();
    const { stub } = await openSession(b); // first bind, no --since
    const c: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:05.000Z")),
      id: crypto.randomUUID(),
    };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });
    // Reconnect WITH a --since spec whose resolver would throw — it must NEVER be consulted on reconnect.
    await runInDurableObject(stub, (inst) => {
      (inst as WithResolve).resolveSinceCursor = async () => {
        throw new Error("resolver must not run on reconnect");
      };
    });
    const res = await connect(stub, b, { sinceSpec: "now" });

    expect(res.status).toBe(101); // reconnect succeeds; the spec is ignored
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      orderKey: c.orderKey,
      id: c.id,
    });
  });
});

describe("ListenSession — ready frame seed cursor (#25)", () => {
  // Capture every frame off a freshly-accepted socket (the ready frame is sent synchronously on connect,
  // buffered until accept()). The ready frame carries the DO's SEEDED/persisted resume position from
  // CONNECT so a streaming client has a cursor before the first event — closing the hide-before-first-event
  // resume gap. SERVER-resolved: it is exactly what the DO seeded/persisted, never a wall clock.
  function framesOf(res: Response): {
    ws: WebSocket;
    frames: { type: string; cursor?: string | null }[];
  } {
    const ws = res.webSocket as WebSocket;
    const frames: { type: string; cursor?: string | null }[] = [];
    ws.addEventListener("message", (e) =>
      frames.push(JSON.parse(typeof e.data === "string" ? e.data : "")),
    );
    ws.accept();
    return { ws, frames };
  }

  async function readyOf(res: Response): Promise<{ type: string; cursor?: string | null }> {
    const { frames } = framesOf(res);
    await vi.waitFor(() => expect(frames.some((f) => f.type === "ready")).toBe(true));
    return frames.find((f) => f.type === "ready")!;
  }

  it("a first-bind since=now ready frame carries the SEEDED head cursor (non-null, decodes to the seed)", async () => {
    const b = newBinding();
    const resolved: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:09.000Z")),
      id: crypto.randomUUID(),
    };
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithResolve).resolveSinceCursor = async () => resolved;
    });
    const res = await connect(stub, b, { sinceSpec: "now" });

    expect(res.status).toBe(101);
    const ready = await readyOf(res);
    expect(typeof ready.cursor).toBe("string");
    // Decodes to EXACTLY the DO's seeded position — proof it is server-resolved, not a client clock.
    expect(await decodeCursor(ready.cursor as string, cursorKey)).toEqual(resolved);
  });

  it("a first-bind beginning/oldest ready frame carries cursor: null (no seed to resume from)", async () => {
    const b = newBinding();
    const stub = stubFor(b.sessionId);
    await runInDurableObject(stub, (inst) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as WithResolve).resolveSinceCursor = async () => undefined;
    });
    const res = await connect(stub, b, { sinceSpec: "beginning" });

    expect(res.status).toBe(101);
    const ready = await readyOf(res);
    expect(ready.cursor).toBeNull();
  });

  it("a RESUME (reconnect) ready frame carries the persisted acked cursor", async () => {
    const b = newBinding();
    const { stub } = await openSession(b); // first bind, no seed → cursor unset (ready cursor is null)
    const c: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:05.000Z")),
      id: crypto.randomUUID(),
    };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });
    const res = await connect(stub, b); // reconnect → ready frame reflects the durable acked cursor

    expect(res.status).toBe(101);
    const ready = await readyOf(res);
    expect(typeof ready.cursor).toBe("string");
    expect(await decodeCursor(ready.cursor as string, cursorKey)).toEqual(c);
  });
});

describe("ListenSession — cursor + at-least-once", () => {
  it("persists the durable resume cursor only on ack", async () => {
    const b = newBinding();
    const { stub } = await openSession(b);

    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toBeUndefined();

    const c: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:02.000Z")),
      id: crypto.randomUUID(),
    };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });

    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      orderKey: c.orderKey,
      id: c.id,
    });
  });

  it("round-trips the acked cursor at EXACT microsecond precision (no ms truncation through the DO)", async () => {
    // The whole point of the µs cursor: a sub-millisecond order key must survive ack → durable store →
    // restore byte-for-byte. The old {receivedAtMs} store (a ms Date) silently dropped the µs; storing the
    // ISO-µs orderKey verbatim keeps it. `.005200Z` (not a whole ms) is the exact case that used to be lost.
    const b = newBinding();
    const { stub } = await openSession(b);
    const c: Cursor = { orderKey: "2026-06-10T12:00:02.005200Z", id: crypto.randomUUID() };
    await runInDurableObject(stub, async (inst, state) => {
      await (inst as ListenSession).webSocketMessage(state.getWebSockets()[0], await ackCursor(c));
    });
    // Verbatim orderKey — the trailing `200µs` is preserved, and toCursor restores the same Cursor shape.
    expect(await runInDurableObject(stub, (_i, s) => s.storage.get("cursor"))).toEqual({
      orderKey: "2026-06-10T12:00:02.005200Z",
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

    const c: Cursor = {
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:05.000Z")),
      id: crypto.randomUUID(),
    };
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

  it("UPGRADES a pre-deploy {receivedAtMs} durable cursor in place on reconnect (no backlog re-flood)", async () => {
    // A session whose durable cursor was written by the pre-µs build reconnects after this deploy. The old
    // {receivedAtMs} ms position must be upgraded to the EQUIVALENT µs order key (`.sss000Z`) and used as the
    // resume — NOT treated as unset, which would resume oldest-inclusive and re-flood the whole backlog as
    // duplicates. The old cursor was already ms-precision, so this resumes from the exact same instant.
    const b = newBinding();
    const calls: (Cursor | undefined)[] = [];
    const { stub } = await openSession(b, async (_binding, resume) => {
      calls.push(resume);
      return { events: [], caughtUp: true };
    });
    const legacyId = crypto.randomUUID();
    await runInDurableObject(stub, (_i, s) =>
      s.storage.put("cursor", { receivedAtMs: Date.UTC(2026, 5, 10, 12, 0, 5, 123), id: legacyId }),
    );
    await connect(stub, b); // reconnect → resets in-memory lastSent, so resume comes from durable storage
    await runDurableObjectAlarm(stub);

    expect(calls.at(-1)).toEqual({ orderKey: "2026-06-10T12:00:05.123000Z", id: legacyId });
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

// The harness property every alarm assertion in this file silently depends on. Without these two, the
// `liveSessions` retention is an invisible crutch: delete it and the suite goes back to failing roughly
// once per few hundred CI runs, in a different test each time, with a message that blames the poll loop.
describe("test harness — the client end outlives the assertion", () => {
  it("retains the Response even when the caller destructures only the stub", async () => {
    // Deterministic half: proves the retention is WIRED. `openSession` throws away `res` exactly as the
    // alarm tests do, so if `connect` stopped retaining, this fails on every machine, immediately.
    const before = liveSessions.length;
    const { stub } = await openSession(newBinding());
    expect(liveSessions.length, "connect must retain the session's client end").toBe(before + 1);
    expect(
      liveSessions.at(-1)?.webSocket,
      "the retained Response must carry the socket",
    ).toBeTruthy();
    // And the socket is the DO's, not just an object we are holding.
    expect(await runInDurableObject(stub, (_i, s) => s.getWebSockets().length)).toBe(1);
  });

  it("keeps the socket attached across heap churn, so the alarm stays armed", async () => {
    // Probabilistic half: proves the retention WORKS. Dropping the Response measured 12.5% loss per
    // iteration under this churn, so 40 iterations catch a regression ~99.5% of the time — while a
    // workerd that stops collecting early only makes this greener, never spuriously red.
    for (let i = 0; i < 40; i++) {
      const { stub } = await openSession(newBinding());
      for (let j = 0; j < 40; j++) new Array(20_000).fill(j);
      await scheduler.wait(0);
      const { alarm, sockets } = await alarmState(stub);
      expect(sockets, `iteration ${i}: the client end was collected mid-test`).toBe(1);
      expect(alarm, `iteration ${i}: alarm lost with ${sockets} live socket(s)`).not.toBeNull();
    }
  }, 60_000);
});

describe("ListenSession — fail-safe alarm + idle", () => {
  it("never throws on a poll error: re-arms the alarm (POLL_DEGRADED, not silence)", async () => {
    const b = newBinding();
    const { stub } = await openSession(b, async () => {
      throw new Error("neon unavailable");
    });

    const ran = await runDurableObjectAlarm(stub); // must not throw
    expect(ran).toBe(true);
    await expectArmed(stub, "the poll loop must be armed");
  });

  it("stops polling once the last socket closes", async () => {
    const b = newBinding();
    const { stub } = await openSession(b);
    await expectArmed(stub, "the poll loop must be armed");

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

  // R1 — the guaranteed 30-minute wedge this discriminator exists to avoid. An org binding stores NO
  // endpointId and the reconnect header carries none either; a naive `existing.endpointId !== endpointId`
  // (undefined !== null) would 403 EVERY org reconnect into a re-mint loop. This proves it does not.
  it("an org-scoped session reconnects to itself without a 403 (R1)", async () => {
    const b = newOrgBinding();
    const first = await openSession(b);
    expect(first.res.status).toBe(101);
    // Same org-scoped session, reconnecting: must upgrade, not wedge.
    expect((await connect(first.stub, b)).status).toBe(101);
    // The persisted binding is org-scoped with no endpoint.
    const binding = await runInDurableObject(first.stub, (_i, state) =>
      state.storage.get<{ scope: string; endpointId?: string }>("binding"),
    );
    expect(binding?.scope).toBe("org");
    expect(binding?.endpointId).toBeUndefined();
  });

  // Deploy compat: a binding persisted by the PRE-scope build has no `scope` field. An endpoint tab whose
  // hibernated session spans the deploy must reconnect cleanly (101) and have its binding UPGRADED in place —
  // not 403 forever on `undefined !== "endpoint"`.
  it("upgrades a legacy scope-less endpoint binding on reconnect (no 403)", async () => {
    const b = newBinding();
    const stub = stubFor(b.sessionId);
    // Seed a PRE-scope binding (no `scope`) and inject the poll seams, exactly as the old build left it.
    await runInDurableObject(stub, async (inst, state) => {
      (inst as Pollable).pollEvents = EMPTY_POLL;
      (inst as Pollable).backlogMeta = EMPTY_META;
      (inst as Pollable).checkStillMember = async () => true;
      await state.storage.put("binding", {
        orgId: b.orgId,
        endpointId: b.endpointId,
        sessionId: b.sessionId,
        boundAtMs: Date.now(),
      });
    });
    // Reconnect with the new scoped header set → must upgrade, not wedge.
    expect((await connect(stub, b)).status).toBe(101);
    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ scope?: string; endpointId?: string }>("binding"),
    );
    expect(binding?.scope).toBe("endpoint"); // upgraded in place
    expect(binding?.endpointId).toBe(b.endpointId);
  });

  it("refuses a reconnect that FLIPS scope (org↔endpoint) on the same session (403)", async () => {
    const b = newOrgBinding();
    const { stub } = await openSession(b);
    // Same org + session, but now presenting an endpoint scope → a scope flip must be refused.
    const asEndpoint = newBinding({ orgId: b.orgId, sessionId: b.sessionId });
    expect((await connect(stub, asEndpoint)).status).toBe(403);
    // And the reverse: an endpoint session can't be re-presented as org-wide.
    const ep = newBinding();
    await openSession(ep);
    const epStub = stubFor(ep.sessionId);
    const asOrg = newOrgBinding({ orgId: ep.orgId, sessionId: ep.sessionId });
    expect((await connect(epStub, asOrg)).status).toBe(403);
  });

  it("streams an org-scoped tail: pollEvents receives an org binding with no endpoint", async () => {
    const b = newOrgBinding();
    const seen: Binding[] = [];
    const poll: PollFn = async (binding) => {
      seen.push(binding);
      return { events: [], caughtUp: true };
    };
    const { stub, res } = await openSession(b, poll);
    expect(res.status).toBe(101);
    (res.webSocket as WebSocket).accept();
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen[0].scope).toBe("org");
    expect(seen[0].endpointId).toBeUndefined();
    expect(seen[0].orgId).toBe(b.orgId);
  });
});

describe("ListenSession — periodic re-authorization (S.8)", () => {
  const REVOKED = async () => false;
  const STILL = async () => true;

  // A live-events socket used to be authorized ONCE at upgrade and then hibernate across evictions for days,
  // re-reading only its persisted binding — never re-checking that the user is still a member. So a removed
  // member's open tab kept streaming event metadata (EventSummary) indefinitely. The dashboard ticket now
  // carries a userId, and the poll periodically re-checks membership.
  it("closes the socket and stops polling when the bound user is no longer a member", async () => {
    const b = newBinding({ userId: crypto.randomUUID() });
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, REVOKED);
    const ws = res.webSocket as WebSocket;
    const frames: { code?: string }[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    let closeCode = 0;
    ws.addEventListener("close", (e) => (closeCode = e.code));
    ws.accept();

    await runDurableObjectAlarm(stub); // the re-auth check runs on the poll tick

    await vi.waitFor(() => expect(closeCode).toBe(1008)); // policy violation → client re-mints/stops
    expect(frames.some((f) => f.code === "REAUTHORIZE")).toBe(true);
    // Stopped: no alarm re-armed, so the DO can hibernate rather than keep streaming to a revoked user.
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("CONSULTS the membership check for a userful binding and keeps streaming when it passes", async () => {
    const b = newBinding({ userId: crypto.randomUUID() });
    let checked = false;
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, async () => {
      checked = true;
      return true;
    });
    const ws = res.webSocket as WebSocket;
    let closeCode = 0;
    ws.addEventListener("close", (e) => (closeCode = e.code));
    ws.accept();

    await runDurableObjectAlarm(stub);

    expect(checked).toBe(true); // the seam WAS consulted (not skipped) — else "revoked" is the only guard
    expect(closeCode).toBe(0); // and it kept streaming
    await expectArmed(stub, "the poll loop must be armed");
  });

  // The CLI/bearer path carries no userId (the api key is the revocable credential). The membership check
  // must be SKIPPED there, never crash or close — revoking the key is that path's control.
  it("does not membership-check a session with no bound user (CLI/bearer)", async () => {
    const b = newBinding(); // no userId
    let checked = false;
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, async () => {
      checked = true;
      return false;
    });
    (res.webSocket as WebSocket).accept();

    await runDurableObjectAlarm(stub);

    expect(checked).toBe(false); // never consulted for a userless binding
    await expectArmed(stub, "the poll loop must be armed");
  });

  // Regression guard for the fail-open throttle: a THROWING membership check must not be retried on the very
  // next poll. Advancing lastReauthMs only on success (the bug) means a DB blip re-opens a tenant connection
  // every ~2s poll per socket — a self-inflicted connection storm during an outage. The throttle is advanced
  // before the read, so a throw still waits the full interval.
  it("does not re-check membership on the next poll after the check THREW (no 2s-cadence storm)", async () => {
    const b = newBinding({ userId: crypto.randomUUID() });
    let calls = 0;
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, async () => {
      calls++;
      throw new Error("tenant db unavailable");
    });
    (res.webSocket as WebSocket).accept();

    await runDurableObjectAlarm(stub); // first poll: checks (throws → fail open), advances the throttle
    await runDurableObjectAlarm(stub); // immediate next poll: within the interval → must SKIP the check

    expect(calls).toBe(1); // NOT 2 — the throw still advanced the throttle
    // Failed open: the socket is kept and polling continues (the lifetime cap is the backstop).
    await expectArmed(stub, "the poll loop must be armed");
  });

  // The absolute-lifetime backstop: independent of membership, a socket older than the cap is closed so the
  // client must re-mint a fresh ticket — which re-runs the session + endpoint RLS check, bounding a stale
  // authorization (e.g. a revoked SESSION on a still-member user) even when the membership check would pass.
  it("closes a socket past the absolute lifetime cap, forcing a re-mint", async () => {
    const b = newBinding({ userId: crypto.randomUUID() });
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, STILL);
    const ws = res.webSocket as WebSocket;
    let closeCode = 0;
    ws.addEventListener("close", (e) => (closeCode = e.code));
    ws.accept();

    // Age the binding past the cap by rewriting boundAtMs — the DO reads it on the next poll.
    await runInDurableObject(stub, async (_i, state) => {
      const bound = (await state.storage.get("binding")) as Record<string, unknown>;
      await state.storage.put("binding", { ...bound, boundAtMs: 1 }); // epoch → far past the cap
    });

    await runDurableObjectAlarm(stub);

    await vi.waitFor(() => expect(closeCode).toBe(1008));
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  // A socket already open when this change deployed has a binding with NO boundAtMs. `Date.now() - undefined`
  // is NaN, so a naive `> MAX` cap silently never fires — the legacy hibernated tail would stream forever,
  // defeating S.8 for exactly the sockets it must bound. The cap fails CLOSED on a missing clock.
  it("terminates a legacy binding that has no boundAtMs (fail closed, not never)", async () => {
    const b = newBinding(); // userless + (below) no boundAtMs — the pre-deploy shape
    const { stub, res } = await openSession(b, EMPTY_POLL, EMPTY_META, STILL);
    const ws = res.webSocket as WebSocket;
    let closeCode = 0;
    ws.addEventListener("close", (e) => (closeCode = e.code));
    ws.accept();

    // Simulate a binding persisted before this change: strip boundAtMs.
    await runInDurableObject(stub, async (_i, state) => {
      const bound = (await state.storage.get("binding")) as Record<string, unknown>;
      delete bound.boundAtMs;
      await state.storage.put("binding", bound);
    });

    await runDurableObjectAlarm(stub);

    await vi.waitFor(() => expect(closeCode).toBe(1008)); // NaN age → treated as expired → terminated
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  // The cap FORCES a re-mint; it must not KILL the session. A reconnect (same sticky sessionId, a fresh
  // ticket the upgrade handler already verified) lands on the same DO and must reset the lifetime clock —
  // otherwise the stale boundAtMs re-closes the fresh socket 1008 immediately and the tail wedges forever.
  it("a reconnect after a lifetime-cap close resets the clock and streams again (not a permanent kill)", async () => {
    const b = newBinding({ userId: crypto.randomUUID() });
    const { stub } = await openSession(b, EMPTY_POLL, EMPTY_META, STILL);

    // Age the binding past the cap, fire the alarm → first socket closed 1008 + poll stopped.
    await runInDurableObject(stub, async (_i, state) => {
      const bound = (await state.storage.get("binding")) as Record<string, unknown>;
      await state.storage.put("binding", { ...bound, boundAtMs: 1 });
    });
    await runDurableObjectAlarm(stub);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();

    // The client reconnects with the SAME sessionId (a fresh ticket already verified upstream). It must NOT
    // be immediately re-closed: the reconnect reset boundAtMs, so a subsequent poll keeps streaming.
    const res2 = await connect(stub, b);
    expect(res2.status).toBe(101);
    const ws2 = res2.webSocket as WebSocket;
    let closeCode2 = 0;
    ws2.addEventListener("close", (e) => (closeCode2 = e.code));
    ws2.accept();

    const bound2 = (await runInDurableObject(stub, (_i, s) => s.storage.get("binding"))) as {
      boundAtMs: number;
    };
    expect(bound2.boundAtMs).toBeGreaterThan(1); // clock reset on reconnect

    await runDurableObjectAlarm(stub);
    expect(closeCode2).toBe(0); // the reconnected socket survives — no permanent kill
    await expectArmed(stub, "the poll loop must be armed");
  });
});

describe("drainPages — bounded multi-page catch-up", () => {
  const at = (s: string): Date => new Date(`2026-06-10T12:00:0${s}.000Z`);
  const cur = (id: string): Cursor => ({ orderKey: orderKeyOf(at("0")), id });

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
      orderKey: orderKeyOf(new Date("2026-06-10T12:00:00.000Z")),
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
