import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { EventSummaryItem } from "@/server/events";

import { EventsTable } from "./events-table";

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
  it("renders no Endpoint column when endpointNames is omitted", () => {
    render(<EventsTable items={[ev(A)]} isFiltered={false} emptyMessage={ONBOARDING} />);
    expect(screen.queryByRole("columnheader", { name: "Endpoint" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });

  it("renders the Endpoint column when endpointNames is set", () => {
    render(
      <EventsTable
        items={[ev(A)]}
        isFiltered={false}
        endpointNames={{ [EP_A]: "stripe-prod" }}
        emptyMessage={ONBOARDING}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(within(screen.getByText(A).closest("tr")!).getByText("stripe-prod")).toBeInTheDocument();
  });

  // The house rule: a raw id is never the visible label. An endpoint absent from the map is a soft-deleted
  // one (ADR-0076 keeps its events listable), so the row must say so rather than print a uuid at the reader.
  it("labels an endpoint missing from the map, and NEVER shows its raw uuid", () => {
    render(
      <EventsTable
        items={[ev(B, { endpointId: EP_B })]}
        isFiltered={false}
        endpointNames={{ [EP_A]: "stripe-prod" }}
        emptyMessage={ONBOARDING}
      />,
    );
    const row = screen.getByText(B).closest("tr")!;
    expect(within(row).getByText("Deleted endpoint")).toBeInTheDocument();
    expect(within(row).queryByText(EP_B)).not.toBeInTheDocument();
  });

  // Rows can come from many endpoints; each must link to ITS OWN. `loadEvent` asserts
  // `event.endpointId !== endpointId → not_found`, so a wrong endpoint in the href is a guaranteed 404.
  it("links every row to its own event's endpoint", () => {
    render(
      <EventsTable
        items={[ev(A), ev(B, { endpointId: EP_B })]}
        isFiltered={false}
        endpointNames={{ [EP_A]: "a", [EP_B]: "b" }}
        emptyMessage={ONBOARDING}
      />,
    );
    expect(within(screen.getByText(A).closest("tr")!).getByRole("link")).toHaveAttribute(
      "href",
      `/endpoints/${EP_A}/events/${A}`,
    );
    expect(within(screen.getByText(B).closest("tr")!).getByRole("link")).toHaveAttribute(
      "href",
      `/endpoints/${EP_B}/events/${B}`,
    );
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

  it("spans the empty row across every column, including Endpoint", () => {
    const { rerender } = render(
      <EventsTable items={[]} isFiltered={false} emptyMessage={ONBOARDING} />,
    );
    expect(screen.getByText(ONBOARDING).closest("td")).toHaveAttribute("colspan", "4");
    rerender(
      <EventsTable items={[]} isFiltered={false} endpointNames={{}} emptyMessage={ONBOARDING} />,
    );
    expect(screen.getByText(ONBOARDING).closest("td")).toHaveAttribute("colspan", "5");
  });
});
