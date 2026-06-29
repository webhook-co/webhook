import { describe, expect, it } from "vitest";

import { firstParam, hasAppliedFilters, parseEventFilters } from "./event-filters";

const PROVIDERS = ["stripe", "github", "shopify"] as const;

describe("firstParam", () => {
  it("passes a string through and returns undefined for undefined", () => {
    expect(firstParam("stripe")).toBe("stripe");
    expect(firstParam(undefined)).toBeUndefined();
  });

  it("takes the first value of a repeated (array) param (first-wins, no throw)", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam([])).toBeUndefined();
  });
});

describe("parseEventFilters", () => {
  it("passes a provider through and drops blank/whitespace + missing values", () => {
    expect(parseEventFilters({ provider: "stripe" })).toEqual({ provider: "stripe" });
    expect(parseEventFilters({ provider: "  " })).toEqual({});
    expect(parseEventFilters({})).toEqual({});
  });

  it("ignores null values (URLSearchParams.get returns null)", () => {
    expect(parseEventFilters({ provider: null, from: null, to: null })).toEqual({});
  });

  it("treats a bare YYYY-MM-DD 'from' as that day's 00:00 UTC (inclusive lower bound)", () => {
    const f = parseEventFilters({ from: "2026-06-01" });
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("treats a bare YYYY-MM-DD 'to' as that day's 00:00 UTC (EXCLUSIVE upper — parity w/ CLI --before)", () => {
    const f = parseEventFilters({ to: "2026-06-02" });
    expect(f.receivedBefore?.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });

  it("honors a full ISO instant for from/to verbatim", () => {
    const f = parseEventFilters({ from: "2026-06-01T08:30:00Z", to: "2026-06-01T09:00:00Z" });
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-01T08:30:00.000Z");
    expect(f.receivedBefore?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });

  it("drops an unparseable date rather than producing an Invalid Date", () => {
    expect(parseEventFilters({ from: "not-a-date", to: "garbage" })).toEqual({});
  });

  it("drops an unknown provider when validProviders is supplied (keeps a known one)", () => {
    expect(parseEventFilters({ provider: "github" }, PROVIDERS)).toEqual({ provider: "github" });
    // A hand-edited ?provider=foobar is dropped → "no filter" rather than a confusing empty result.
    expect(parseEventFilters({ provider: "foobar" }, PROVIDERS)).toEqual({});
  });

  it("parses a valid verification status and drops an unknown one (closed enum)", () => {
    expect(parseEventFilters({ status: "failed" })).toEqual({ verificationState: "failed" });
    expect(parseEventFilters({ status: "verified" })).toEqual({ verificationState: "verified" });
    expect(parseEventFilters({ status: "bogus" })).toEqual({}); // hand-edited junk dropped
    expect(parseEventFilters({ status: "  " })).toEqual({});
  });

  it("passes a trimmed search term through and drops blank", () => {
    expect(parseEventFilters({ search: "  evt_123  " })).toEqual({ search: "evt_123" });
    expect(parseEventFilters({ search: "   " })).toEqual({});
    expect(parseEventFilters({ search: null })).toEqual({});
  });

  it("caps search at 256 chars (parity with the contract .max(256)) — over-long is dropped", () => {
    // A hand-edited `?search=` longer than the contract ceiling is dropped rather than run, so the web
    // surface never accepts a longer term than API/CLI/MCP would (the contract `.trim().min(1).max(256)`).
    expect(parseEventFilters({ search: "a".repeat(256) })).toEqual({ search: "a".repeat(256) });
    expect(parseEventFilters({ search: "a".repeat(257) })).toEqual({});
    // Trim happens BEFORE the length check, so trailing whitespace doesn't push a 256-char term over.
    expect(parseEventFilters({ search: `${"a".repeat(256)}   ` })).toEqual({
      search: "a".repeat(256),
    });
  });
});

describe("parseEventFilters — date range presets (?range=)", () => {
  const NOW = new Date("2026-06-29T12:00:00.000Z");

  it("resolves a valid preset to a receivedAfter bound (now − window), no upper bound", () => {
    const f = parseEventFilters({ range: "7d" }, undefined, NOW);
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-22T12:00:00.000Z");
    expect(f.receivedBefore).toBeUndefined();
  });

  it("lets a valid preset OWN the range — custom from/to are ignored", () => {
    const f = parseEventFilters(
      { range: "24h", from: "2026-01-01", to: "2026-01-02" },
      undefined,
      NOW,
    );
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-28T12:00:00.000Z");
    expect(f.receivedBefore).toBeUndefined();
  });

  it("falls through to from/to when the preset id is unknown (hand-edited ?range=foo)", () => {
    const f = parseEventFilters(
      { range: "foo", from: "2026-06-01", to: "2026-06-02" },
      undefined,
      NOW,
    );
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(f.receivedBefore?.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });

  it("applies plain from/to when no range is present", () => {
    const f = parseEventFilters({ from: "2026-06-01" }, undefined, NOW);
    expect(f.receivedAfter?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("hasAppliedFilters", () => {
  it("reflects the PARSED filters (a dropped bad date is not 'filtered')", () => {
    expect(hasAppliedFilters({})).toBe(false);
    expect(hasAppliedFilters(parseEventFilters({ from: "oops" }))).toBe(false); // bad date dropped
    expect(hasAppliedFilters(parseEventFilters({ provider: "stripe" }, PROVIDERS))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({ from: "2026-06-01" }))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({ status: "failed" }))).toBe(true);
  });
});
