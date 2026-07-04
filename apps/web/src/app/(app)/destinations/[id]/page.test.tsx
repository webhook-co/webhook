import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DestinationItem } from "@/server/replay-destinations";

// A sentinel notFound() — the real one throws to halt rendering; the mock throws a recognizable error so
// the test can assert the not-found path was taken.
const NOT_FOUND = new Error("NEXT_NOT_FOUND");
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw NOT_FOUND;
  }),
}));
vi.mock("@/server/session", () => ({
  verifySession: vi.fn(async () => ({ userId: "usr_1", orgId: "org_1" })),
}));

const loaders = vi.hoisted(() => ({
  loadDestinations: vi.fn(),
  loadDeliveries: vi.fn(),
}));
vi.mock("@/server/replay-destinations", () => ({ loadDestinations: loaders.loadDestinations }));
vi.mock("@/server/deliveries", () => ({ loadDeliveries: loaders.loadDeliveries }));
vi.mock("@/server/delivery-actions", () => ({ loadMoreDeliveriesAction: vi.fn() }));

import DestinationDetailPage from "./page";

const UUID = "11111111-1111-4111-8111-111111111111";

function dest(over: Partial<DestinationItem> = {}): DestinationItem {
  return {
    id: UUID,
    url: "https://api.example.com/hook",
    label: "Orders",
    status: "active",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastValidatedAt: null,
    ordered: false,
    disabledAt: null,
    ...over,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DestinationDetailPage", () => {
  it("renders notFound for a non-uuid route id", async () => {
    await expect(
      DestinationDetailPage({ params: Promise.resolve({ id: "not-a-uuid" }) }),
    ).rejects.toBe(NOT_FOUND);
    expect(loaders.loadDestinations).not.toHaveBeenCalled();
  });

  it("renders notFound when the destination isn't in the org's list", async () => {
    loaders.loadDestinations.mockResolvedValue({ status: "ok", items: [] });
    loaders.loadDeliveries.mockResolvedValue({ status: "ok", items: [], nextCursor: null });
    await expect(DestinationDetailPage({ params: Promise.resolve({ id: UUID }) })).rejects.toBe(
      NOT_FOUND,
    );
  });

  it("renders a danger banner when destinations fail to load", async () => {
    loaders.loadDestinations.mockResolvedValue({ status: "error" });
    loaders.loadDeliveries.mockResolvedValue({ status: "ok", items: [], nextCursor: null });
    render(await DestinationDetailPage({ params: Promise.resolve({ id: UUID }) }));
    expect(screen.getByText(/couldn't load this destination/i)).toBeInTheDocument();
  });

  it("renders the summary and the deliveries embed on success", async () => {
    loaders.loadDestinations.mockResolvedValue({ status: "ok", items: [dest()] });
    loaders.loadDeliveries.mockResolvedValue({ status: "ok", items: [], nextCursor: null });
    render(await DestinationDetailPage({ params: Promise.resolve({ id: UUID }) }));

    expect(screen.getByRole("heading", { name: "Destination" })).toBeInTheDocument();
    expect(screen.getByText("https://api.example.com/hook")).toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /destinations/i })).toHaveAttribute(
      "href",
      "/destinations",
    );
    // The embed renders with its intrinsic (non-filtered) onboarding empty copy.
    expect(screen.getByText(/no deliveries yet/i)).toBeInTheDocument();
    // loadDeliveries is scoped to this destination.
    expect(loaders.loadDeliveries).toHaveBeenCalledWith("org_1", { destinationId: UUID });
  });

  it("resolves an owned destination reached via an uppercase-hex id (canonical lowercase match)", async () => {
    // isUuid is case-insensitive; the stored id is lowercase. An uppercase route id must still resolve.
    loaders.loadDestinations.mockResolvedValue({ status: "ok", items: [dest()] });
    loaders.loadDeliveries.mockResolvedValue({ status: "ok", items: [], nextCursor: null });
    render(await DestinationDetailPage({ params: Promise.resolve({ id: UUID.toUpperCase() }) }));
    // Not a 404 — the summary renders, and the deliveries load is scoped to the LOWERCASED id.
    expect(screen.getByText("https://api.example.com/hook")).toBeInTheDocument();
    expect(loaders.loadDeliveries).toHaveBeenCalledWith("org_1", { destinationId: UUID });
  });

  it("surfaces a delivery-load failure without hiding the summary", async () => {
    loaders.loadDestinations.mockResolvedValue({ status: "ok", items: [dest()] });
    loaders.loadDeliveries.mockResolvedValue({ status: "error" });
    render(await DestinationDetailPage({ params: Promise.resolve({ id: UUID }) }));

    expect(screen.getByText("https://api.example.com/hook")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load deliveries/i)).toBeInTheDocument();
  });
});
