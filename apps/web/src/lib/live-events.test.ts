import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import {
  backoffMs,
  createLiveEventsSession,
  type LiveConnectionStatus,
  type LiveStatus,
  type MintTicketResult,
} from "./live-events";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
const ORG_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50aa";

/** A hand-driven WebSocket stand-in: the test pushes frames and closes; no network, no real timers. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // ── test drivers ──
  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  raw(data: string): void {
    this.onmessage?.({ data });
  }
  ready(sessionId: string): void {
    this.message({ type: "ready", sessionId, watermarkDeltaMs: 0 });
  }
  fireClose(): void {
    this.onclose?.();
  }
}

function summaryFrame(id = EVENT_ID, cursor = "cur-1") {
  return {
    type: "event",
    cursor,
    summary: {
      id,
      orgId: ORG_ID,
      endpointId: ENDPOINT_ID,
      receivedAt: "2026-07-01T10:00:00.000Z",
      provider: "stripe",
      dedupKey: "evt_1",
      dedupStrategy: "sw_webhook_id",
      verified: true,
      verificationState: "verified",
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  events: EventSummaryItem[];
  statuses: LiveStatus[];
  connections: LiveConnectionStatus[];
  errors: string[];
  timers: Array<() => void>;
  mint: ReturnType<typeof vi.fn>;
}

function makeHarness(mintResult: MintTicketResult): Harness & {
  start: (
    over?: Partial<Parameters<typeof createLiveEventsSession>[0]>,
  ) => ReturnType<typeof createLiveEventsSession>;
} {
  const events: EventSummaryItem[] = [];
  const statuses: LiveStatus[] = [];
  const connections: LiveConnectionStatus[] = [];
  const errors: string[] = [];
  const timers: Array<() => void> = [];
  const mint = vi.fn(async () => mintResult);
  return {
    events,
    statuses,
    connections,
    errors,
    timers,
    mint,
    start: (over = {}) =>
      createLiveEventsSession({
        wsUrl: "wss://wbhk.my/listen",
        endpointId: ENDPOINT_ID,
        mintTicket: mint,
        onEvent: (item) => events.push(item),
        onStatus: (s) => statuses.push(s),
        onConnectionChange: (c) => connections.push(c),
        onError: (m) => errors.push(m),
        WebSocketCtor: FakeWebSocket as never,
        setTimeoutFn: (fn) => {
          timers.push(fn);
          return timers.length - 1;
        },
        clearTimeoutFn: () => {},
        ...over,
      }),
  };
}

const OK_TICKET: MintTicketResult = {
  ok: true,
  ticket: "tok-abc",
  subprotocol: "wbhk.listen.v1",
};

afterEach(() => {
  FakeWebSocket.instances = [];
});

describe("createLiveEventsSession", () => {
  it("mints a ticket, opens the socket with the ticket subprotocol, and marks connected on ready", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();

    // mintTicket is now scope-agnostic + pre-bound (zero-arg); the endpointId lives in the session option and
    // shapes the query, not the mint call.
    expect(h.mint).toHaveBeenCalledWith();
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws.url).toBe(`wss://wbhk.my/listen?endpointId=${ENDPOINT_ID}&since=now`);
    // offers the base subprotocol + the ticket-bearing token (never hardcoded here).
    expect(ws.protocols).toEqual(["wbhk.listen.v1", "ticket.tok-abc"]);

    ws.ready("sess-1");
    expect(h.connections).toContain("connected");
    session.stop();
  });

  it("an ORG tail (no endpointId) omits endpointId from the query — scope comes from the ticket", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start({ endpointId: undefined });
    await flush();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    // No endpointId param at all; the org-scoped ticket (minted by the caller) is what widens the tail.
    expect(ws.url).toBe("wss://wbhk.my/listen?since=now");
    expect(ws.url).not.toContain("endpointId");
    expect(h.mint).toHaveBeenCalledWith();
    session.stop();
  });

  it("maps an event summary to a browser-safe item (drops orgId) and acks its cursor", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();
    const ws = FakeWebSocket.instances[0];
    ws.ready("sess-1");

    ws.message(summaryFrame(EVENT_ID, "cur-9"));

    expect(h.events).toHaveLength(1);
    const item = h.events[0];
    expect(item.id).toBe(EVENT_ID);
    expect(item.provider).toBe("stripe");
    expect(item.verified).toBe(true);
    expect(item.verificationState).toBe("verified");
    expect(item.receivedAt).toBeInstanceOf(Date);
    // orgId must never survive the projection to the client item.
    expect(item as Record<string, unknown>).not.toHaveProperty("orgId");
    // acked the exact cursor via a client ack frame.
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "ack", cursor: "cur-9" });
    session.stop();
  });

  it("surfaces caughtUp + lag from a status frame", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();
    const ws = FakeWebSocket.instances[0];
    ws.ready("sess-1");

    ws.message({ type: "status", caughtUp: false, lag: { backlogCount: 42 } });
    expect(h.statuses.at(-1)).toEqual({ caughtUp: false, lag: { backlogCount: 42 } });

    ws.message({ type: "status", caughtUp: true });
    expect(h.statuses.at(-1)).toEqual({ caughtUp: true, lag: undefined });
    session.stop();
  });

  it("reconnects after a close, reusing the ready sessionId on the resume query", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();
    const first = FakeWebSocket.instances[0];
    first.ready("sess-77");

    first.fireClose();
    // a close schedules a reconnect via the injected timer — nothing reconnects until it fires.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.timers).toHaveLength(1);

    h.timers[0]();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    expect(second.url).toContain(`endpointId=${ENDPOINT_ID}`);
    expect(second.url).toContain("sessionId=sess-77");
    session.stop();
  });

  it("treats a returned {ok:false} mint as terminal — surfaces the reason, no socket, no re-mint", async () => {
    const h = makeHarness({ ok: false, error: "nope" });
    const session = h.start();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.connections.at(-1)).toBe("disconnected");
    // surfaces the server-provided reason, unobtrusively (no throw).
    expect(h.errors).toContain("nope");
    // A business refusal is PERMANENT: no reconnect timer is scheduled, and mint is not retried forever.
    expect(h.timers).toHaveLength(0);
    expect(h.mint).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("retries (reconnects) when the ticket mint THROWS (a transient fault, not a refusal)", async () => {
    const events: EventSummaryItem[] = [];
    const connections: LiveConnectionStatus[] = [];
    const timers: Array<() => void> = [];
    let calls = 0;
    const mint = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network blip");
      return OK_TICKET;
    });
    const session = createLiveEventsSession({
      wsUrl: "wss://wbhk.my/listen",
      endpointId: ENDPOINT_ID,
      mintTicket: mint,
      onEvent: (item) => events.push(item),
      onStatus: () => {},
      onConnectionChange: (c) => connections.push(c),
      WebSocketCtor: FakeWebSocket as never,
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeoutFn: () => {},
    });
    await flush();
    // The transient throw scheduled a reconnect timer (unlike a {ok:false} refusal).
    expect(timers).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    timers[0](); // fire the reconnect → re-mint succeeds → socket opens
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    session.stop();
  });

  it("ignores a malformed frame without crashing or emitting", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();
    const ws = FakeWebSocket.instances[0];
    ws.ready("sess-1");

    ws.raw("}{ not json");
    ws.message({ type: "totally-unknown" });

    expect(h.events).toHaveLength(0);
    expect(ws.sent).toHaveLength(0);
    session.stop();
  });

  it("stop() closes the socket and cancels a pending reconnect", async () => {
    const clear = vi.fn();
    const timers: Array<() => void> = [];
    const session = createLiveEventsSession({
      wsUrl: "wss://wbhk.my/listen",
      endpointId: ENDPOINT_ID,
      mintTicket: async () => OK_TICKET,
      onEvent: () => {},
      onStatus: () => {},
      onConnectionChange: () => {},
      WebSocketCtor: FakeWebSocket as never,
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeoutFn: clear,
    });
    await flush();
    const ws = FakeWebSocket.instances[0];
    ws.ready("s");
    ws.fireClose();
    session.stop();
    expect(clear).toHaveBeenCalled();
    // a reconnect timer that fires after stop must not open a new socket.
    timers.forEach((fn) => fn());
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("backoffMs", () => {
  it("grows the delay by doubling and caps it", () => {
    const noJitter = () => 0;
    expect(backoffMs(1, noJitter, 500, 30_000)).toBe(250);
    expect(backoffMs(2, noJitter, 500, 30_000)).toBe(500);
    expect(backoffMs(3, noJitter, 500, 30_000)).toBe(1000);
    // capped: attempt 20 would overflow the ceiling without the cap.
    expect(backoffMs(20, noJitter, 500, 30_000)).toBe(15_000);
  });

  it("adds jitter within the upper half of the capped window", () => {
    // attempt 3 caps at 2000ms: half fixed (1000) + up to half random (0..1000).
    expect(backoffMs(3, () => 1, 500, 30_000)).toBe(2000);
    expect(backoffMs(3, () => 0.5, 500, 30_000)).toBe(1500);
    expect(backoffMs(3, () => 0, 500, 30_000)).toBe(1000);
  });
});

// THE TAIL STARTS AT THE HEAD, NOT AT THE DAWN OF THE ENDPOINT.
//
// A SHIPPED BUG. The dashboard sent only endpointId (+ sessionId), so the DO's `since` branches never ran and
// the seed cursor stayed unset — and its own comment says unset means "oldest-inclusive". So switching Live on
// replayed the endpoint's entire retained history, oldest first, and the newest event — the ONLY reason anyone
// clicks Live — arrived last, after the backlog. Latent so far only because endpoints are young; the org-wide
// tail multiplies it by up to 100 endpoints.
//
// The engine already accepts the grammar (now|beginning|<duration>|<RFC3339>) and resolves it server-side; the
// dashboard simply never asked. The previous version of the URL assertion above PINNED the bug — it asserted
// the exact url, with no `since`, and passed happily.
describe("createLiveEventsSession — Live means live", () => {
  it("a fresh go-live asks for since=now, so the reader gets no history", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start();
    await flush();
    expect(FakeWebSocket.instances[0].url).toContain("since=now");
    expect(FakeWebSocket.instances[0].url).not.toContain("sinceCursor");
    session.stop();
  });

  // A PAUSE is not a fresh start. The hook stops the session when the tab hides, so coming back builds a new
  // session with NO sticky sessionId — a first-bind. Re-seeding at `now` there would silently drop everything
  // that arrived while the tab was hidden: those events came in while Live was ON, so they are not history,
  // and losing them would be a worse bug than the replay this change removes.
  it("a resumed tail seeds from the last cursor it saw, not from now", async () => {
    const h = makeHarness(OK_TICKET);
    const session = h.start({ seedFrom: "cur-abc" });
    await flush();
    expect(FakeWebSocket.instances[0].url).toContain("sinceCursor=cur-abc");
    expect(FakeWebSocket.instances[0].url).not.toContain("since=now");
    session.stop();
  });

  // The resume position has to come from somewhere: every delivered event reports its cursor, which is what
  // the hook holds across the pause.
  it("reports each delivered event's cursor so a pause can be resumed", async () => {
    const seen: string[] = [];
    const h = makeHarness(OK_TICKET);
    const session = h.start({ onCursor: (c) => seen.push(c) });
    await flush();
    const ws = FakeWebSocket.instances[0];
    ws.ready("sess-1");
    ws.message(summaryFrame(EVENT_ID, "cur-1"));
    expect(seen).toEqual(["cur-1"]);
    session.stop();
  });
});
