import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventSummaryItem } from "@/server/events";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { MintTicketResult } from "@/lib/live-events";

import { OrgEventsList } from "./org-events-list";

// useOrgSlug()/orgHref need the slug param (mirrors events-list.test.tsx's note); the org events list rows
// deep-link to the per-endpoint detail path, so the prefix must resolve.
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
}));

const EP_A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50a1";
const EP_B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50b2";
const ORG_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50aa";
const LIVE_WS = "wss://wbhk.my/listen";

/** A driveable WebSocket stand-in — captures the URL (to prove the ORG query omits endpointId). */
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
  /** Emit an event on a chosen endpoint (org tail spans many). */
  event(id: string, endpointId: string, cursor = "c"): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        cursor,
        summary: {
          id,
          orgId: ORG_ID,
          endpointId,
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

const OK_MINT: MintTicketResult = { ok: true, ticket: "tok-org", subprotocol: "wbhk.listen.v1" };
const mintOrg = vi.fn(async () => OK_MINT);

function ev(id: string, endpointId: string): EventSummaryItem {
  return {
    id,
    endpointId,
    receivedAt: new Date("2026-06-28T12:00:00Z"),
    provider: "stripe",
    dedupKey: "evt",
    dedupStrategy: "sw_webhook_id",
    verified: true,
    verificationState: "verified",
  };
}

const NAMES = {
  [EP_A]: { name: "orders-prod", deleted: false },
  [EP_B]: { name: "billing-prod", deleted: false },
};

const SEED = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5001";
const LIVE = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5002";

function renderList(over: Partial<React.ComponentProps<typeof OrgEventsList>> = {}) {
  return render(
    <OrgEventsList
      initialItems={[ev(SEED, EP_A)]}
      initialCursor={null}
      filterParams={{}}
      isFiltered={false}
      endpointNames={NAMES}
      loadMore={vi.fn<() => Promise<LoadMoreEventsResult>>()}
      liveWsUrl={LIVE_WS}
      mintTicket={mintOrg}
      webSocketCtor={FakeWebSocket as never}
      {...over}
    />,
  );
}

afterEach(() => {
  FakeWebSocket.instances = [];
  mintOrg.mockClear();
});

describe("OrgEventsList — org-wide live tail", () => {
  it("toggling live opens a socket whose query OMITS endpointId (org scope)", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole("button", { name: /go live/i }));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0];
    // The whole point of the org tail: no endpointId in the query — scope comes from the org ticket.
    expect(ws.url).toContain("since=now");
    expect(ws.url).not.toContain("endpointId");
    expect(mintOrg).toHaveBeenCalledWith(); // scope-agnostic, pre-bound (no endpointId arg)
  });

  it("a live event from ANY endpoint prepends and renders its own endpoint name", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole("button", { name: /go live/i }));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0];
    act(() => ws.ready());

    // An event on a DIFFERENT endpoint than the seed row — the org tail must show it, with ITS endpoint name.
    act(() => ws.event(LIVE, EP_B));
    await waitFor(() => expect(screen.getByText("billing-prod")).toBeInTheDocument());
    // The seed row's endpoint is still shown too (multi-endpoint stream).
    expect(screen.getByText("orders-prod")).toBeInTheDocument();
  });

  it("renders no live toggle when the wiring is absent", () => {
    renderList({ liveWsUrl: undefined, mintTicket: undefined });
    expect(screen.queryByRole("button", { name: /go live/i })).not.toBeInTheDocument();
  });
});
