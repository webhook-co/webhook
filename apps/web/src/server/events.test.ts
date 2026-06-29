import type { Cursor } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import {
  loadEvent,
  loadEvents,
  loadMoreEvents,
  revealHeader,
  type EventDetailItem,
  type EventReaders,
  type EventSummaryItem,
} from "./events";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

const summary: EventSummaryItem = {
  id: EVENT_ID,
  endpointId: ENDPOINT_ID,
  receivedAt: new Date("2026-06-28T00:00:00Z"),
  provider: "stripe",
  dedupKey: "evt_123",
  dedupStrategy: "sw_webhook_id",
  verified: true,
};

const detail: EventDetailItem = {
  ...summary,
  payloadBytes: 42,
  contentType: "application/json",
  headers: [{ name: "content-type", value: "application/json", sensitive: false }],
  providerEventId: "evt_123",
  externalId: null,
  verification: { ok: true, keyId: "key_1", scheme: "stripe" },
};

const cursor: Cursor = { receivedAt: new Date("2026-06-28T00:00:00Z"), id: EVENT_ID };

function readers(over: Partial<EventReaders> = {}): EventReaders {
  return {
    firstPage: vi.fn(async () => ({
      meta: { name: "Stripe prod", deleted: false },
      page: { items: [summary], nextCursor: null },
    })),
    listEvents: vi.fn(async () => ({ items: [summary], nextCursor: null })),
    getEvent: vi.fn(async () => detail),
    revealHeader: vi.fn(async () => ({ value: "Bearer secret" })),
    ...over,
  };
}

describe("loadEvents", () => {
  it("returns the endpoint name + events on success", async () => {
    const result = await loadEvents("o", ENDPOINT_ID, readers());
    expect(result).toEqual({
      status: "ok",
      endpointName: "Stripe prod",
      deleted: false,
      items: [summary],
      nextCursor: null,
    });
  });

  it("flags a soft-deleted endpoint (events still listable)", async () => {
    const result = await loadEvents(
      "o",
      ENDPOINT_ID,
      readers({
        firstPage: vi.fn(async () => ({
          meta: { name: "Stripe prod", deleted: true },
          page: { items: [summary], nextCursor: null },
        })),
      }),
    );
    expect(result).toMatchObject({ status: "ok", deleted: true });
  });

  it("returns not_found when the endpoint doesn't exist", async () => {
    const result = await loadEvents(
      "o",
      ENDPOINT_ID,
      readers({
        firstPage: vi.fn(async () => ({ meta: null, page: { items: [], nextCursor: null } })),
      }),
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found for a non-uuid endpoint id WITHOUT touching the db", async () => {
    const r = readers();
    const result = await loadEvents("o", "not-a-uuid", r);
    expect(result).toEqual({ status: "not_found" });
    expect(r.firstPage).not.toHaveBeenCalled();
  });

  it("surfaces a db fault as the error state (no throw)", async () => {
    const result = await loadEvents(
      "o",
      ENDPOINT_ID,
      readers({
        firstPage: vi.fn(async () => {
          throw new Error("hyperdrive down");
        }),
      }),
    );
    expect(result).toEqual({ status: "error" });
  });
});

describe("loadEvent", () => {
  it("returns the event on success", async () => {
    const result = await loadEvent("o", ENDPOINT_ID, EVENT_ID, readers());
    expect(result).toEqual({ status: "ok", event: detail });
  });

  it("returns not_found for an unknown / cross-org event", async () => {
    const result = await loadEvent(
      "o",
      ENDPOINT_ID,
      EVENT_ID,
      readers({ getEvent: vi.fn(async () => null) }),
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when the event belongs to a DIFFERENT endpoint (canonical URL)", async () => {
    const otherEndpoint = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5099";
    const result = await loadEvent(
      "o",
      otherEndpoint,
      EVENT_ID,
      readers({ getEvent: vi.fn(async () => detail) }),
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found for a non-uuid id WITHOUT touching the db", async () => {
    const r = readers();
    expect(await loadEvent("o", ENDPOINT_ID, "nope", r)).toEqual({ status: "not_found" });
    expect(r.getEvent).not.toHaveBeenCalled();
  });

  it("surfaces a db fault as the error state (no throw)", async () => {
    const result = await loadEvent(
      "o",
      ENDPOINT_ID,
      EVENT_ID,
      readers({
        getEvent: vi.fn(async () => {
          throw new Error("hyperdrive down");
        }),
      }),
    );
    expect(result).toEqual({ status: "error" });
  });
});

describe("loadMoreEvents", () => {
  it("returns the next page via the injected reader", async () => {
    const next = { receivedAt: new Date("2026-06-27T00:00:00Z"), id: EVENT_ID };
    const r = readers({ listEvents: vi.fn(async () => ({ items: [summary], nextCursor: next })) });
    const page = await loadMoreEvents("o", ENDPOINT_ID, cursor, r);
    expect(page).toEqual({ items: [summary], nextCursor: next });
    expect(r.listEvents).toHaveBeenCalledWith("o", ENDPOINT_ID, cursor);
  });
});

describe("revealHeader", () => {
  const input = { endpointId: ENDPOINT_ID, eventId: EVENT_ID, index: 1 };

  it("returns the value via the injected reader", async () => {
    const r = readers({ revealHeader: vi.fn(async () => ({ value: "Bearer xyz" })) });
    expect(await revealHeader("o", input, r)).toEqual({ value: "Bearer xyz" });
    expect(r.revealHeader).toHaveBeenCalledWith("o", input);
  });

  it("returns null when the reader finds no sensitive header at the index", async () => {
    const r = readers({ revealHeader: vi.fn(async () => null) });
    expect(await revealHeader("o", { ...input, index: 9 }, r)).toBeNull();
  });
});
