import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import type { MintTicketResult } from "./live-events";
import { LIVE_RESUME_MAX_PAUSE_MS, useLiveEvents } from "./use-live-events";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const ORG_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50aa";

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
  ready(sessionId = "s"): void {
    this.onmessage?.({ data: JSON.stringify({ type: "ready", sessionId, watermarkDeltaMs: 0 }) });
  }
  event(id: string, cursor = "c"): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        cursor,
        summary: {
          id,
          orgId: ORG_ID,
          endpointId: ENDPOINT_ID,
          receivedAt: "2026-07-01T10:00:00.000Z",
          provider: "stripe",
          dedupKey: "k",
          dedupStrategy: "sw_webhook_id",
          verified: true,
          verificationState: "verified",
        },
      }),
    });
  }
}

const OK: MintTicketResult = { ok: true, ticket: "tok", subprotocol: "wbhk.listen.v1" };
// A stable reference, mirroring the real server-action import the component passes (never re-created per
// render — an unstable mintTicket would churn the connect effect).
const mintOk = async () => OK;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function existing(id: string): EventSummaryItem {
  return {
    id,
    endpointId: ENDPOINT_ID,
    receivedAt: new Date("2026-06-01T00:00:00Z"),
    provider: "stripe",
    dedupKey: "k",
    dedupStrategy: "sw_webhook_id",
    verified: true,
    verificationState: "verified",
  };
}

function useHarness(opts: { enabled: boolean; initial?: readonly EventSummaryItem[] }) {
  const [items, setItems] = React.useState<readonly EventSummaryItem[]>(opts.initial ?? []);
  const state = useLiveEvents({
    enabled: opts.enabled,
    wsUrl: "wss://wbhk.my/listen",
    endpointId: ENDPOINT_ID,
    mintTicket: mintOk,
    setItems,
    WebSocketCtor: FakeWebSocket as never,
  });
  return { items, state };
}

afterEach(() => {
  FakeWebSocket.instances = [];
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useLiveEvents", () => {
  it("opens a socket when enabled and prepends + dedups incoming events by id", async () => {
    const EXISTING = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
    const NEW = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5062";
    const { result } = renderHook(() =>
      useHarness({ enabled: true, initial: [existing(EXISTING)] }),
    );
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();

    act(() => ws.ready());
    expect(result.current.state.connection).toBe("connected");

    // A brand-new live event prepends to the top.
    act(() => ws.event(NEW));
    expect(result.current.items.map((e) => e.id)).toEqual([NEW, EXISTING]);

    // A duplicate of an event already in the list is ignored (no doubling).
    act(() => ws.event(EXISTING));
    expect(result.current.items.map((e) => e.id)).toEqual([NEW, EXISTING]);
  });

  it("dedups a live event against a row already in the list even after many events (no head-cap eviction)", async () => {
    // Guards the removed-cap decision: prepend must dedup against the FULL list (incl. paginated rows at the
    // tail), and must never evict rows by slicing. Seed a row, pump many live events, then re-deliver the seed
    // — it must NOT double, and the seed must still be present (not sliced off the tail).
    const SEED = "0190a1b2-c3d4-7e5f-8a0b-0000dead0001";
    const { result } = renderHook(() => useHarness({ enabled: true, initial: [existing(SEED)] }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    act(() => ws.ready());
    act(() => {
      for (let i = 0; i < 200; i++) {
        ws.event(`0190a1b2-c3d4-7e5f-8a0b-${String(i).padStart(12, "0")}`);
      }
    });
    // The seed (an anchored/paginated-style row) is still present at the tail — never evicted.
    expect(result.current.items.some((e) => e.id === SEED)).toBe(true);
    const before = result.current.items.length;
    // Re-delivering the seed does not double it (dedup scans the full list, not a capped window).
    act(() => ws.event(SEED));
    expect(result.current.items.filter((e) => e.id === SEED)).toHaveLength(1);
    expect(result.current.items).toHaveLength(before);
  });

  it("reflects caughtUp / lag from status frames", async () => {
    const { result } = renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    act(() => ws.ready());

    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({ type: "status", caughtUp: false, lag: { backlogCount: 5 } }),
      }),
    );
    expect(result.current.state.caughtUp).toBe(false);
    expect(result.current.state.lag).toEqual({ backlogCount: 5 });
  });

  it("pauses (closes the socket) when the tab is hidden and does not open one while hidden", async () => {
    const { result } = renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws.closed).toBe(false);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });

    expect(ws.closed).toBe(true);
    expect(result.current.state.connection).toBe("disconnected");
    // Still enabled, but hidden → no new socket is opened.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not open a socket when disabled", async () => {
    renderHook(() => useHarness({ enabled: false }));
    await act(async () => {
      await flush();
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes the socket on unmount", async () => {
    const { unmount } = renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    unmount();
    expect(ws.closed).toBe(true);
  });
});

// LIVE MEANS LIVE — and a PAUSE is not a fresh start. These two rules pull in opposite directions, and the
// bug was picking one of them. The seed is where they meet, so this is where they are pinned.
describe("useLiveEvents — the seed distinguishes going live from carrying on", () => {
  it("a fresh go-live asks for since=now: the reader gets no history", async () => {
    renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    expect(FakeWebSocket.instances[0].url).toContain("since=now");
    expect(FakeWebSocket.instances[0].url).not.toContain("sinceCursor");
  });

  // THE DATA-LOSS BUG. The hook stops the session when the tab hides, so coming back is a FIRST-BIND with no
  // sticky sessionId. Re-seeding at `now` there silently drops everything that arrived while the tab was
  // hidden — events that came in while Live was ON, i.e. not history at all. The `since=now` fix on its own
  // traded a noisy replay for silent loss; the cursor is what makes the pause lossless.
  it("resumes a hidden-tab pause from the last cursor seen, not from now", async () => {
    const { result } = renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    act(() => FakeWebSocket.instances[0].ready());
    // A real uuid: the frame is schema-parsed, and a junk id is dropped before onCursor ever fires.
    const E1 = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5071";
    act(() => FakeWebSocket.instances[0].event(E1, "cur-42"));
    expect(result.current.items.map((i) => i.id)).toContain(E1);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });

    const resumed = FakeWebSocket.instances[1];
    expect(resumed).toBeDefined();
    expect(resumed.url).toContain("sinceCursor=cur-42");
    expect(resumed.url).not.toContain("since=now");
  });

  // Toggling Live OFF ends the live intent, so ON is a NEW one. Without dropping the cursor, toggling off,
  // going to lunch and toggling on would replay the whole lunch — the history replay this change removes,
  // reintroduced through the resume path.
  it("a Live off/on is a NEW go-live: back to since=now, not a resume", async () => {
    const { rerender } = renderHook(({ on }: { on: boolean }) => useHarness({ enabled: on }), {
      initialProps: { on: true },
    });
    await act(async () => {
      await flush();
    });
    act(() => FakeWebSocket.instances[0].ready());
    act(() => FakeWebSocket.instances[0].event("0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5072", "cur-42"));

    await act(async () => {
      rerender({ on: false });
      await flush();
    });
    await act(async () => {
      rerender({ on: true });
      await flush();
    });

    const relit = FakeWebSocket.instances[1];
    expect(relit).toBeDefined();
    expect(relit.url).toContain("since=now");
    expect(relit.url).not.toContain("sinceCursor");
  });
});

// A PAUSE HAS A SHELF LIFE. Resuming from the last cursor is right for a tab switch and wrong for a weekend.
//
// The ref survives indefinitely: hiding a tab does not unmount the component, it only flips `visible`. So a
// reader who turned Live on at 17:00 Friday and shut the lid would, on Monday, resume from Friday's cursor
// and watch the DO drain the entire weekend into the live list, oldest-first. That is the history-replay the
// whole change removes, re-entering through the resume path the change adds — and the ONE rule here is that
// Live never shows history.
describe("useLiveEvents — a stale pause restarts live rather than replaying the gap", () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  async function hideThenShow(afterMs: number) {
    const t0 = realNow();
    Date.now = () => t0;
    const { result } = renderHook(() => useHarness({ enabled: true }));
    await act(async () => {
      await flush();
    });
    act(() => FakeWebSocket.instances[0].ready());
    act(() =>
      FakeWebSocket.instances[0].event("0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5081", "cur-friday"),
    );

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });
    // The lid is shut. Wall-clock advances; Date.now() is the only thing that can see it.
    Date.now = () => t0 + afterMs;
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });
    return { result, resumed: FakeWebSocket.instances[1] };
  }

  it("a BRIEF pause resumes from the cursor (no events lost)", async () => {
    const { resumed } = await hideThenShow(30_000);
    expect(resumed.url).toContain("sinceCursor=cur-friday");
  });

  it("a LONG pause starts live again instead of dumping the backlog", async () => {
    const { resumed } = await hideThenShow(LIVE_RESUME_MAX_PAUSE_MS + 1);
    expect(resumed.url).toContain("since=now");
    expect(resumed.url).not.toContain("sinceCursor");
  });
});
