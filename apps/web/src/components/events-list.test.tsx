import type { Cursor } from "@webhook-co/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import { EventsList } from "./events-list";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

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
});
