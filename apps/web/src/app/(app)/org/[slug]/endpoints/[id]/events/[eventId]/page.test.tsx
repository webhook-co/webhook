import { render } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { EventDetailItem } from "@/server/events";

// A sentinel notFound() — the real one throws to halt rendering; the mock throws a recognizable error so
// the test can assert the not-found path was taken.
const NOT_FOUND = new Error("NEXT_NOT_FOUND");
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw NOT_FOUND;
  }),
}));
vi.mock("@/server/org-access", () => ({
  requireActiveOrgAccess: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    slug: "acme",
    role: "owner",
  })),
}));

const loaders = vi.hoisted(() => ({
  loadEvent: vi.fn(),
  loadDestinations: vi.fn(async () => ({ status: "ok", items: [] })),
  detailProps: vi.fn(),
}));
vi.mock("@/server/events", () => ({ loadEvent: loaders.loadEvent }));
vi.mock("@/server/replay-destinations", () => ({ loadDestinations: loaders.loadDestinations }));
vi.mock("@/server/event-actions", () => ({
  deleteEventAction: vi.fn(),
  loadEventPayloadAction: vi.fn(),
  revealHeaderAction: vi.fn(),
}));
vi.mock("@/server/replay-actions", () => ({ replayToDestinationAction: vi.fn() }));
// Capture the props the page hands the detail view — `endpointId` is what the reveal + payload actions are
// bound with, so it is the value that must be canonical.
vi.mock("@/components/event-detail", () => ({
  EventDetail: (props: Record<string, unknown>) => {
    loaders.detailProps(props);
    return null;
  },
}));

import EventDetailPage from "./page";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

const event = {
  id: EVENT_ID,
  endpointId: ENDPOINT_ID,
  receivedAt: new Date("2026-07-01T00:00:00Z"),
  provider: "stripe",
  dedupKey: "evt_1",
  dedupStrategy: "unique",
  verified: true,
  payloadBytes: 10,
  contentType: "application/json",
  method: "POST",
  headers: [],
  providerEventId: null,
  externalId: null,
  verification: null,
} as unknown as EventDetailItem;

afterEach(() => {
  vi.clearAllMocks();
});

describe("EventDetailPage", () => {
  it("404s when the event read reports not_found", async () => {
    loaders.loadEvent.mockResolvedValue({ status: "not_found" });
    await expect(
      EventDetailPage({
        params: Promise.resolve({ slug: "acme", id: ENDPOINT_ID, eventId: EVENT_ID }),
      }),
    ).rejects.toBe(NOT_FOUND);
  });

  // A uuid path segment is case-INsensitive by shape, but every id we store and compare is canonical
  // lowercase. Canonicalize once, at the route boundary — the same thing destinations/[id] does — so the
  // page read, the reveal action and the payload download all address the event the SAME way. Without it an
  // uppercase-hex URL renders a page whose click-to-reveal and payload download both silently fail.
  it("canonicalizes an UPPERCASE route id before reading and before binding the actions", async () => {
    loaders.loadEvent.mockResolvedValue({ status: "ok", event });
    // The page is an async Server Component: awaiting it yields the element tree, and EventDetail is not
    // invoked until that tree is rendered. Render it, so the props assertion is about what really reaches
    // the component rather than about a tree nobody looked at.
    render(
      await EventDetailPage({
        params: Promise.resolve({
          slug: "acme",
          id: ENDPOINT_ID.toUpperCase(),
          eventId: EVENT_ID.toUpperCase(),
        }),
      }),
    );

    expect(loaders.loadEvent).toHaveBeenCalledWith("org_1", ENDPOINT_ID, EVENT_ID);
    expect(loaders.detailProps).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: ENDPOINT_ID }),
    );
  });
});
