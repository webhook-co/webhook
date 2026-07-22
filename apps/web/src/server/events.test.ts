import type { Cursor } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import type { EventFilters } from "@/lib/event-filters";

import {
  loadEvent,
  loadEvents,
  loadMoreEvents,
  loadOrgEvents,
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

const cursor: Cursor = { orderKey: "2026-06-28T00:00:00.000000Z", id: EVENT_ID };

function readers(over: Partial<EventReaders> = {}): EventReaders {
  return {
    firstPage: vi.fn(async () => ({
      meta: { name: "Stripe prod", deleted: false },
      page: { items: [summary], nextCursor: null },
    })),
    listEvents: vi.fn(async () => ({ items: [summary], nextCursor: null })),
    getEvent: vi.fn(async () => detail),
    // The org-wide browse pair. They belong here even though most cases below drive the per-endpoint
    // readers: the factory's return type CLAIMS to be a whole EventReaders, and every `readers(over)` call
    // hands that claim to code under test. Omitting them left the object structurally short of the
    // interface — a defect the excluded-from-tsconfig test file could never report.
    orgFirstPage: vi.fn(async () => ({
      page: { items: [summary], nextCursor: null },
      endpointNames: { [ENDPOINT_ID]: { name: "Stripe prod", deleted: false } },
    })),
    listOrgEvents: vi.fn(async () => ({ items: [summary], nextCursor: null })),
    revealHeader: vi.fn(async () => ({ value: "Bearer secret" })),
    ...over,
  };
}

describe("loadEvents", () => {
  it("returns the endpoint name + events on success", async () => {
    const result = await loadEvents("o", ENDPOINT_ID, undefined, readers());
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
      undefined,
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
      undefined,
      readers({
        firstPage: vi.fn(async () => ({ meta: null, page: { items: [], nextCursor: null } })),
      }),
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found for a non-uuid endpoint id WITHOUT touching the db", async () => {
    const r = readers();
    const result = await loadEvents("o", "not-a-uuid", undefined, r);
    expect(result).toEqual({ status: "not_found" });
    expect(r.firstPage).not.toHaveBeenCalled();
  });

  it("threads the active filters into the first-page reader", async () => {
    const r = readers();
    const filters: EventFilters = {
      provider: ["github"],
      receivedAfter: new Date("2026-06-01T00:00:00Z"),
    };
    await loadEvents("o", ENDPOINT_ID, filters, r);
    expect(r.firstPage).toHaveBeenCalledWith("o", ENDPOINT_ID, filters);
  });

  it("surfaces a db fault as the error state (no throw), reason=unknown", async () => {
    const result = await loadEvents(
      "o",
      ENDPOINT_ID,
      undefined,
      readers({
        firstPage: vi.fn(async () => {
          throw new Error("hyperdrive down");
        }),
      }),
    );
    expect(result).toEqual({ status: "error", reason: "unknown" });
  });

  // #24 follow-up: the per-endpoint page browses ALL-TIME (no 7d default), so the new unindexed headerSearch
  // residual can DETERMINISTICALLY blow the 5s browse timeout — Postgres cancels with 57014. Like loadOrgEvents,
  // loadEvents must preserve that signal so the page can advise "narrow the date range" instead of a useless
  // "Refresh" (which re-runs the identical timeout).
  it("reports reason=timeout when Postgres cancels the statement (57014)", async () => {
    const pgError = (code: string) => Object.assign(new Error("canceling statement"), { code });
    const result = await loadEvents(
      "o",
      ENDPOINT_ID,
      undefined,
      readers({
        firstPage: vi.fn(async () => {
          throw pgError("57014");
        }),
      }),
    );
    expect(result).toEqual({ status: "error", reason: "timeout" });
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

  // isUuid accepts EITHER case, but ids are stored canonically lowercase — so an uppercase-hex endpoint
  // segment passes the shape gate and then fails the exact-match `!==`, 404ing an event the caller owns and
  // the list just showed them. The destinations detail page normalizes for exactly this reason
  // (destinations/[id]/page.tsx); this read must too, or the two surfaces disagree about the same URL.
  it("resolves an event when the endpoint segment is UPPERCASE hex (case-insensitive uuid)", async () => {
    const result = await loadEvent("o", ENDPOINT_ID.toUpperCase(), EVENT_ID, readers());
    expect(result).toEqual({ status: "ok", event: detail });
  });

  it("resolves an event when the EVENT segment is UPPERCASE hex", async () => {
    const r = readers();
    const result = await loadEvent("o", ENDPOINT_ID, EVENT_ID.toUpperCase(), r);
    expect(result).toEqual({ status: "ok", event: detail });
    // The db must be asked for the CANONICAL id, not the caller's casing.
    expect(r.getEvent).toHaveBeenCalledWith("o", EVENT_ID);
  });

  // The widening must not reach past case: a different endpoint still 404s.
  it("still returns not_found for a DIFFERENT endpoint given in uppercase", async () => {
    const otherEndpoint = "0190A1B2-C3D4-7E5F-8A0B-1C2D3E4F5099";
    const result = await loadEvent("o", otherEndpoint, EVENT_ID, readers());
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
    const next: Cursor = { orderKey: "2026-06-27T00:00:00.000000Z", id: EVENT_ID };
    const r = readers({ listEvents: vi.fn(async () => ({ items: [summary], nextCursor: next })) });
    const page = await loadMoreEvents("o", ENDPOINT_ID, cursor, undefined, r);
    expect(page).toEqual({ items: [summary], nextCursor: next });
    expect(r.listEvents).toHaveBeenCalledWith("o", ENDPOINT_ID, cursor, undefined);
  });

  it("threads the active filters into the load-more reader", async () => {
    const r = readers();
    const filters: EventFilters = {
      provider: ["stripe"],
      receivedBefore: new Date("2026-06-02T00:00:00Z"),
    };
    await loadMoreEvents("o", ENDPOINT_ID, cursor, filters, r);
    expect(r.listEvents).toHaveBeenCalledWith("o", ENDPOINT_ID, cursor, filters);
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

// A TIMED-OUT BROWSE IS NOT A BLIP, AND THE PAGE MUST BE ABLE TO TELL.
//
// browseEvents bounds every events browse with a 5s statement_timeout — the guard that makes the org page's
// one-click "Any time" survivable. When it fires, Postgres cancels with SQLSTATE 57014. That failure is
// DETERMINISTIC: the same query times out again, so the generic "Refresh to try again" is advice that cannot
// work. The reader has to narrow the window, and they can only know that if we say so — which the page can
// only do if this layer distinguishes the two.
describe("loadOrgEvents — a timeout is reported as a timeout", () => {
  const pgError = (code: string) => Object.assign(new Error("canceling statement"), { code });

  it("reports reason=timeout when Postgres cancels the statement (57014)", async () => {
    const result = await loadOrgEvents("o", undefined, {
      ...readers(),
      orgFirstPage: vi.fn(async () => {
        throw pgError("57014");
      }),
    } as unknown as EventReaders);
    expect(result).toEqual({ status: "error", reason: "timeout" });
  });

  it("reports reason=unknown for any other fault (where refreshing IS the right advice)", async () => {
    const result = await loadOrgEvents("o", undefined, {
      ...readers(),
      orgFirstPage: vi.fn(async () => {
        throw pgError("08006"); // connection failure — a genuine blip
      }),
    } as unknown as EventReaders);
    expect(result).toEqual({ status: "error", reason: "unknown" });
  });

  it("reports reason=unknown for a non-Postgres throw (no code at all)", async () => {
    const result = await loadOrgEvents("o", undefined, {
      ...readers(),
      orgFirstPage: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as EventReaders);
    expect(result).toEqual({ status: "error", reason: "unknown" });
  });
});
