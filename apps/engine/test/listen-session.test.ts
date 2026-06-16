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
} as const;

interface Binding {
  orgId: string;
  endpointId: string;
  sessionId: string;
}
type PollFn = (binding: Binding, resume: Cursor | undefined) => Promise<EventSummary[]>;
/** The DO with its protected poll seam exposed for injection (tests aren't typechecked by tsc). */
type Pollable = ListenSession & { pollEvents: PollFn };
const EMPTY_POLL: PollFn = async () => [];

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
  opts: { since?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    [HDR.ORG]: b.orgId,
    [HDR.ENDPOINT]: b.endpointId,
    [HDR.SESSION]: b.sessionId,
  };
  if (opts.since) headers[HDR.SINCE] = opts.since;
  return stub.fetch("https://engine.example/listen", { headers });
}

/** Inject the poll seam (defaults to empty) THEN connect — so the auto-firing alarm never hits PG. */
async function openSession(
  b: Binding,
  poll: PollFn = EMPTY_POLL,
): Promise<{ stub: DurableObjectStub; res: Response }> {
  const stub = stubFor(b.sessionId);
  await runInDurableObject(stub, (inst) => {
    (inst as Pollable).pollEvents = poll;
  });
  const res = await connect(stub, b);
  return { stub, res };
}

describe("ListenSession — connect + stream", () => {
  it("accepts the WebSocket and streams a ready frame then event frames", async () => {
    const b = newBinding();
    const s1 = summaryAt(new Date("2026-06-10T12:00:00.000Z"));
    const s2 = summaryAt(new Date("2026-06-10T12:00:01.000Z"));
    const { stub, res } = await openSession(b, async () => [s1, s2]);

    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    const msgs: { type: string; summary?: { id: string }; cursor?: string; sessionId?: string }[] =
      [];
    ws.addEventListener("message", (e) => {
      msgs.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
    });
    ws.accept();

    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(msgs.length).toBeGreaterThanOrEqual(3));

    expect(msgs[0]).toMatchObject({
      type: "ready",
      sessionId: b.sessionId,
      watermarkDeltaMs: 5000,
    });
    expect(msgs[1]).toMatchObject({ type: "event", summary: { id: s1.id } });
    expect(msgs[2]).toMatchObject({ type: "event", summary: { id: s2.id } });
    expect(typeof msgs[1].cursor).toBe("string");

    const count = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    expect(count).toBe(1);
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
      return [];
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

    expect(out).toHaveLength(3); // every page's items
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
    expect(out).toHaveLength(3);
  });
});
