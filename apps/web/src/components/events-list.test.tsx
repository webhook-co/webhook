import type { Cursor } from "@webhook-co/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventSummaryItem } from "@/server/events";
import type { MintTicketResult } from "@/lib/live-events";

import { EventsList } from "./events-list";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const ORG_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50aa";
const LIVE_WS = "wss://wbhk.my/listen";

/** A driveable WebSocket stand-in for the Live toggle tests (no network). */
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
  status(caughtUp: boolean, backlogCount?: number): void {
    const lag = backlogCount === undefined ? undefined : { backlogCount };
    this.onmessage?.({ data: JSON.stringify({ type: "status", caughtUp, lag }) });
  }
}

const OK_MINT: MintTicketResult = { ok: true, ticket: "tok", subprotocol: "wbhk.listen.v1" };
const mintOk = async () => OK_MINT;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function ev(id: string, over: Partial<EventSummaryItem> = {}): EventSummaryItem {
  return {
    id,
    endpointId: ENDPOINT_ID,
    receivedAt: new Date("2026-06-28T12:00:00Z"),
    provider: "stripe",
    dedupKey: "evt",
    dedupStrategy: "sw_webhook_id",
    verified: true,
    verificationState: "verified",
    ...over,
  };
}

const A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
const B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5062";
const C = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5063";

describe("EventsList", () => {
  it("renders an empty state when there are no events", () => {
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("shows a filtered-empty message (not the onboarding copy) when filters are active", () => {
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[]}
        initialCursor={null}
        filterParams={{ provider: "github" }}
        isFiltered={true}
        loadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/no events match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/no events yet/i)).not.toBeInTheDocument();
  });

  it("threads the active filterParams into the load-more action", async () => {
    const user = userEvent.setup();
    const cursor: Cursor = { receivedAt: new Date("2026-06-28T12:00:00Z"), id: A };
    const loadMore = vi.fn(async () => ({ ok: true as const, items: [], nextCursor: null }));
    const filterParams = { provider: "stripe", from: "2026-06-01" };
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A)]}
        initialCursor={cursor}
        filterParams={filterParams}
        isFiltered={true}
        loadMore={loadMore}
      />,
    );
    await user.click(screen.getByRole("button", { name: /load older events/i }));
    expect(loadMore).toHaveBeenCalledWith({
      endpointId: ENDPOINT_ID,
      cursor,
      filters: filterParams,
    });
  });

  it("renders the tri-state verification pill: verified (ok) / failed (red) / unattempted (neutral)", () => {
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[
          ev(A, { verificationState: "verified" }),
          ev(B, { verified: false, verificationState: "failed" }),
          ev(C, { verified: false, verificationState: "unattempted", provider: null }),
        ]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    // Scope to each row (the table HEADER cell is also "Verified", so a bare getByText collides).
    expect(within(screen.getByText(A).closest("tr")!).getByText("Verified")).toBeInTheDocument();
    // A genuine signature failure now shows red "Failed" on the list (ADR-0077 amendment).
    expect(within(screen.getByText(B).closest("tr")!).getByText("Failed")).toBeInTheDocument();
    // Unattempted stays neutral "Not verified" (never alarms) + the null-provider placeholder.
    const unattemptedRow = screen.getByText(C).closest("tr")!;
    expect(within(unattemptedRow).getByText("Not verified")).toBeInTheDocument();
    expect(within(unattemptedRow).getByText("—")).toBeInTheDocument();
    // links to the event detail
    expect(within(screen.getByText(A).closest("tr")!).getByRole("link")).toHaveAttribute(
      "href",
      `/endpoints/${ENDPOINT_ID}/events/${A}`,
    );
  });

  it("loads more, appends the next page, and hides the button when the cursor is exhausted", async () => {
    const user = userEvent.setup();
    const cursor: Cursor = { receivedAt: new Date("2026-06-28T12:00:00Z"), id: A };
    const loadMore = vi.fn(async () => ({
      ok: true as const,
      items: [ev(B)],
      nextCursor: null,
    }));
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A)]}
        initialCursor={cursor}
        filterParams={{}}
        isFiltered={false}
        loadMore={loadMore}
      />,
    );

    await user.click(screen.getByRole("button", { name: /load older events/i }));
    expect(loadMore).toHaveBeenCalledWith({ endpointId: ENDPOINT_ID, cursor, filters: {} });
    await waitFor(() => expect(screen.getByText(B)).toBeInTheDocument());
    // both pages are now shown
    expect(screen.getByText(A)).toBeInTheDocument();
    // cursor exhausted → the button is gone
    expect(screen.queryByRole("button", { name: /load older events/i })).not.toBeInTheDocument();
  });

  it("surfaces a load-more failure without losing the existing rows", async () => {
    const user = userEvent.setup();
    const cursor: Cursor = { receivedAt: new Date("2026-06-28T12:00:00Z"), id: A };
    const loadMore = vi.fn(async () => ({ ok: false as const }));
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A)]}
        initialCursor={cursor}
        filterParams={{}}
        isFiltered={false}
        loadMore={loadMore}
      />,
    );
    await user.click(screen.getByRole("button", { name: /load older events/i }));
    await waitFor(() => expect(screen.getByText(/couldn't load more events/i)).toBeInTheDocument());
    expect(screen.getByText(A)).toBeInTheDocument();
  });

  it("renders the provider display name + brand logo in its cell, and a placeholder for a null provider", () => {
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A, { provider: "stripe" }), ev(B, { provider: null })]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    // The provider cell shows the display NAME (not the raw "stripe" slug) + the brand mark (an inline SVG).
    const stripeCell = screen.getByText("Stripe").closest("td")!;
    expect(stripeCell.querySelector("svg")).toBeTruthy();
    // A null provider renders the "—" placeholder with no logo in that cell.
    const nullRow = screen.getByText(B).closest("tr")!;
    const placeholder = within(nullRow).getByText("—");
    expect(placeholder.closest("td")!.querySelector("svg")).toBeNull();
  });
});

describe("EventsList live tail", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  function renderLive(mintTicket: (id: string) => Promise<MintTicketResult> = mintOk) {
    return render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A)]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
        liveWsUrl={LIVE_WS}
        mintTicket={mintTicket}
        webSocketCtor={FakeWebSocket as never}
      />,
    );
  }

  it("toggling live opens a socket; an incoming event prepends and dedups an id already present", async () => {
    const user = userEvent.setup();
    renderLive();

    await user.click(screen.getByRole("button", { name: /go live/i }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    // offered the base + ticket subprotocol (single-sourced, not hardcoded in the client).
    expect(ws.protocols).toEqual(["wbhk.listen.v1", "ticket.tok"]);

    act(() => ws.ready());
    // a brand-new live event lands at the TOP of the list.
    act(() => ws.event(B));
    await waitFor(() => expect(screen.getByText(B)).toBeInTheDocument());
    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    expect(within(rows[0]).getByText(B)).toBeInTheDocument();

    // a live re-delivery of an id already shown does not double the row.
    act(() => ws.event(A));
    await act(async () => {
      await flush();
    });
    expect(screen.getAllByText(A)).toHaveLength(1);
  });

  it("shows an honest caught-up / behind indicator (never claims 'instant')", async () => {
    const user = userEvent.setup();
    renderLive();
    await user.click(screen.getByRole("button", { name: /go live/i }));
    await act(async () => {
      await flush();
    });
    const ws = FakeWebSocket.instances[0];
    act(() => ws.ready());

    act(() => ws.status(true));
    await waitFor(() => expect(screen.getByText(/live · caught up/i)).toBeInTheDocument());

    act(() => ws.status(false, 7));
    await waitFor(() => expect(screen.getByText(/live · 7 behind/i)).toBeInTheDocument());

    // the copy never promises instant delivery.
    expect(screen.queryByText(/instant/i)).not.toBeInTheDocument();
  });

  it("pauses (closes) the socket when the tab is hidden", async () => {
    const user = userEvent.setup();
    renderLive();
    await user.click(screen.getByRole("button", { name: /go live/i }));
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
    // still only the one socket — a hidden tab doesn't reopen.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("a mint failure shows an unobtrusive notice and leaves the paginated list intact", async () => {
    const user = userEvent.setup();
    renderLive(async () => ({ ok: false, error: "That endpoint no longer exists." }));

    await user.click(screen.getByRole("button", { name: /go live/i }));
    await waitFor(() =>
      expect(screen.getByText(/that endpoint no longer exists/i)).toBeInTheDocument(),
    );
    // no socket was opened, and the existing row is untouched.
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(screen.getByText(A)).toBeInTheDocument();
  });

  it("does not render the live toggle when the wiring is absent", () => {
    render(
      <EventsList
        endpointId={ENDPOINT_ID}
        initialItems={[ev(A)]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /go live/i })).not.toBeInTheDocument();
  });
});
