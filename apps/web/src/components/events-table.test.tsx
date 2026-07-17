import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import { EventsTable } from "./events-table";

// Without this, `useOrgSlug()` returns "" and `orgHref` degrades to the BARE path — every href assertion
// below would then pin a string production never emits, and deleting the `orgHref(slug, …)` wrapper would
// leave this file green. org-url.ts:11 names the trap: "a link that forgets the prefix is a 404, and neither
// the type checker nor a unit test that only asserts 'there is an anchor here' will notice."
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
}));

const EP_A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EP_B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5099";
const A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
const B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5062";

function ev(id: string, over: Partial<EventSummaryItem> = {}): EventSummaryItem {
  return {
    id,
    endpointId: EP_A,
    receivedAt: new Date("2026-06-28T12:00:00Z"),
    provider: "stripe",
    dedupKey: "evt",
    dedupStrategy: "sw_webhook_id",
    verified: true,
    verificationState: "verified",
    ...over,
  };
}

const ONBOARDING = "No events yet. Point a provider at this endpoint's webhook URL.";

describe("EventsTable", () => {
  // Rows can come from more than one endpoint (the org-wide browse), and each must link to ITS OWN.
  // `loadEvent` asserts `event.endpointId !== endpointId → not_found`, so a wrong endpoint in the href is a
  // guaranteed 404 — and so is a MISSING /org/{slug} prefix, which the mock above is what makes visible.
  it("links every row to its own event's endpoint, under the org prefix", () => {
    render(
      <EventsTable
        items={[ev(A), ev(B, { endpointId: EP_B })]}
        isFiltered={false}
        emptyMessage={ONBOARDING}
      />,
    );
    expect(within(screen.getByText(A).closest("tr")!).getByRole("link")).toHaveAttribute(
      "href",
      `/org/acme/endpoints/${EP_A}/events/${A}`,
    );
    expect(within(screen.getByText(B).closest("tr")!).getByRole("link")).toHaveAttribute(
      "href",
      `/org/acme/endpoints/${EP_B}/events/${B}`,
    );
  });

  it("renders the tri-state verification pill and the null-provider placeholder", () => {
    render(
      <EventsTable
        items={[
          ev(A, { verificationState: "verified" }),
          ev(B, { verified: false, verificationState: "unattempted", provider: null }),
        ]}
        isFiltered={false}
        emptyMessage={ONBOARDING}
      />,
    );
    // Scope to the row: the table HEADER cell is also "Verified", so a bare getByText collides.
    expect(within(screen.getByText(A).closest("tr")!).getByText("Verified")).toBeInTheDocument();
    const row = screen.getByText(B).closest("tr")!;
    expect(within(row).getByText("Not verified")).toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("shows the caller's onboarding copy when empty and unfiltered", () => {
    render(<EventsTable items={[]} isFiltered={false} emptyMessage={ONBOARDING} />);
    expect(screen.getByText(ONBOARDING)).toBeInTheDocument();
    expect(screen.queryByText(/no events match these filters/i)).not.toBeInTheDocument();
  });

  // A dropped/invalid param must not claim "no events match" — that would blame the reader for our parse.
  it("shows filtered-empty copy (not the onboarding copy) when filters are applied", () => {
    render(<EventsTable items={[]} isFiltered emptyMessage={ONBOARDING} />);
    expect(screen.getByText(/no events match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(ONBOARDING)).not.toBeInTheDocument();
  });

  it("spans the empty row across every column", () => {
    render(<EventsTable items={[]} isFiltered={false} emptyMessage={ONBOARDING} />);
    expect(screen.getByText(ONBOARDING).closest("td")).toHaveAttribute("colspan", "4");
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });
});
