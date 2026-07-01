import type { Cursor, Delivery } from "@webhook-co/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DeliveriesFilterBar, DeliveriesList } from "./deliveries-list";

// The filter bar is URL-driven (next/navigation); stub the hooks so it renders deterministically with no
// query. The list itself doesn't read these hooks (only next/link), so this mock is inert for its tests.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/deliveries",
  useSearchParams: () => new URLSearchParams(""),
}));

const A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
const B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5062";
const DEST = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4faaaa";
const EVT = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4fbbbb";

function del(id: string, over: Partial<Delivery> = {}): Delivery {
  return {
    id,
    eventId: EVT,
    destinationId: DEST,
    subscriptionId: null,
    status: "delivered",
    statusCode: 200,
    attempt: 1,
    error: null,
    nextRetryAt: null,
    createdAt: new Date("2026-06-28T12:00:00Z"),
    ...over,
  };
}

describe("DeliveriesList", () => {
  it("renders the onboarding empty state when there are no deliveries and no filter", () => {
    render(
      <DeliveriesList
        initialItems={[]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/no deliveries yet/i)).toBeInTheDocument();
  });

  it("shows a filtered-empty message (not the onboarding copy) when a filter is active", () => {
    render(
      <DeliveriesList
        initialItems={[]}
        initialCursor={null}
        filterParams={{ status: "failed" }}
        isFiltered={true}
        loadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/no deliveries match this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/no deliveries yet/i)).not.toBeInTheDocument();
  });

  it("renders the status pill from deliveryCopy (label + hint) and links the row to the detail", () => {
    render(
      <DeliveriesList
        initialItems={[
          del(A, { status: "delivered" }),
          del(B, { status: "blocked", statusCode: null, destinationId: null }),
        ]}
        initialCursor={null}
        filterParams={{}}
        isFiltered={false}
        loadMore={vi.fn()}
      />,
    );
    const deliveredRow = screen.getByText("Delivered").closest("tr")!;
    expect(within(deliveredRow).getByRole("link")).toHaveAttribute("href", `/deliveries/${A}`);
    // The blocked row shows the honest hint from deliveryCopy; a blocked (non-forwarded) null destination
    // is an em-dash placeholder, never mislabeled "localhost".
    const blockedRow = screen.getByText("Blocked").closest("tr")!;
    expect(within(blockedRow).getByText(/the destination isn't allowed/i)).toBeInTheDocument();
    expect(within(blockedRow).getByText("—")).toBeInTheDocument();
    expect(within(blockedRow).queryByText("localhost")).not.toBeInTheDocument();
  });

  it("threads the active filterParams into the load-more action and appends the next page", async () => {
    const user = userEvent.setup();
    const cursor: Cursor = { orderKey: "2026-06-28T12:00:00.000000Z", id: A };
    const loadMore = vi.fn(async () => ({
      ok: true as const,
      items: [del(B)],
      nextCursor: null,
    }));
    render(
      <DeliveriesList
        initialItems={[del(A)]}
        initialCursor={cursor}
        filterParams={{ status: "delivered" }}
        isFiltered={true}
        loadMore={loadMore}
      />,
    );
    await user.click(screen.getByRole("button", { name: /load older deliveries/i }));
    expect(loadMore).toHaveBeenCalledWith({ cursor, filters: { status: "delivered" } });
    // The appended page's row links to its own detail; both pages are now shown.
    await waitFor(() =>
      expect(document.querySelector(`a[href="/deliveries/${B}"]`)).toBeInTheDocument(),
    );
    expect(document.querySelector(`a[href="/deliveries/${A}"]`)).toBeInTheDocument();
    // cursor exhausted → button gone
    expect(
      screen.queryByRole("button", { name: /load older deliveries/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a load-more failure without losing the existing rows", async () => {
    const user = userEvent.setup();
    const cursor: Cursor = { orderKey: "2026-06-28T12:00:00.000000Z", id: A };
    const loadMore = vi.fn(async () => ({ ok: false as const }));
    render(
      <DeliveriesList
        initialItems={[del(A)]}
        initialCursor={cursor}
        filterParams={{}}
        isFiltered={false}
        loadMore={loadMore}
      />,
    );
    await user.click(screen.getByRole("button", { name: /load older deliveries/i }));
    await waitFor(() =>
      expect(screen.getByText(/couldn't load more deliveries/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(shortEvt()).length).toBeGreaterThan(0);
  });
});

// The short event id (first 8 chars) as rendered in the Event cell.
function shortEvt(): string {
  return EVT.slice(0, 8);
}

describe("DeliveriesFilterBar", () => {
  it("offers the delivery-status vocabulary as options (plain labels, not raw enum)", async () => {
    render(<DeliveriesFilterBar />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by status/ }));
    expect(screen.getByRole("option", { name: "Delivered" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Undelivered" })).toBeInTheDocument();
    // The raw enum value is never the visible option label.
    expect(screen.queryByRole("option", { name: "dead" })).not.toBeInTheDocument();
  });
});
