import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import type { MintTicketResult } from "./live-events";
import { useLiveEvents } from "./use-live-events";

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
