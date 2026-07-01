import { describe, expect, it } from "vitest";

import { hasAppliedDeliveryFilters, parseDeliveryFilters } from "./delivery-filters";

describe("parseDeliveryFilters", () => {
  it("parses a single valid status into an array", () => {
    expect(parseDeliveryFilters({ status: "delivered" })).toEqual({ status: ["delivered"] });
  });

  it("parses a repeated (array) status param into a de-duped array", () => {
    expect(parseDeliveryFilters({ status: ["failed", "dead", "failed"] })).toEqual({
      status: ["failed", "dead"],
    });
  });

  it("drops unknown status members (silently) and keeps the known ones", () => {
    // A hand-edited `?status=foo` member is dropped; a known one alongside it survives.
    expect(parseDeliveryFilters({ status: ["bogus", "queued"] })).toEqual({ status: ["queued"] });
    // All-unknown → no filter (not a confusing empty result).
    expect(parseDeliveryFilters({ status: "bogus" })).toEqual({});
  });

  it("drops blank/whitespace + missing + null values", () => {
    expect(parseDeliveryFilters({ status: "  " })).toEqual({});
    expect(parseDeliveryFilters({ status: [] })).toEqual({});
    expect(parseDeliveryFilters({ status: null })).toEqual({});
    expect(parseDeliveryFilters({})).toEqual({});
  });

  it("accepts every member of the delivery-status vocabulary", () => {
    expect(
      parseDeliveryFilters({
        status: [
          "queued",
          "forwarded",
          "pending",
          "delivered",
          "failed",
          "blocked",
          "dead",
          "cancelled",
        ],
      }),
    ).toEqual({
      status: [
        "queued",
        "forwarded",
        "pending",
        "delivered",
        "failed",
        "blocked",
        "dead",
        "cancelled",
      ],
    });
  });
});

describe("hasAppliedDeliveryFilters", () => {
  it("reflects the PARSED filters (a dropped bad status is not 'filtered')", () => {
    expect(hasAppliedDeliveryFilters({})).toBe(false);
    expect(hasAppliedDeliveryFilters(parseDeliveryFilters({ status: "bogus" }))).toBe(false);
    expect(hasAppliedDeliveryFilters(parseDeliveryFilters({ status: "delivered" }))).toBe(true);
  });

  it("counts the contextual destination/subscription scopes as applied", () => {
    expect(hasAppliedDeliveryFilters({ destinationId: "d" })).toBe(true);
    expect(hasAppliedDeliveryFilters({ subscriptionId: "s" })).toBe(true);
  });
});
