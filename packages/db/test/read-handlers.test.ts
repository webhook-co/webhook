import { describe, expect, it } from "vitest";

import { resolveReceivedAfter } from "../src/read-handlers";

// `receivedAfter` accepts the `--since` grammar (relative dates), unlike the strict-instant `receivedBefore`.
// Pure resolution — no DB — so it lives here rather than in the real-PG suite.
describe("resolveReceivedAfter", () => {
  it("undefined / empty → no lower bound", () => {
    expect(resolveReceivedAfter(undefined)).toBeUndefined();
    expect(resolveReceivedAfter("")).toBeUndefined();
  });

  it("`beginning` → no lower bound (from the oldest)", () => {
    expect(resolveReceivedAfter("beginning")).toBeUndefined();
  });

  it("`now` → ~the current instant", () => {
    const before = Date.now();
    const d = resolveReceivedAfter("now")!;
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("a duration like `7d` → now minus that duration", () => {
    const d = resolveReceivedAfter("7d")!;
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // within a small tolerance of the computed offset (both read Date.now within a few ms)
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(1000);
  });

  it("`30m` → now minus 30 minutes", () => {
    const d = resolveReceivedAfter("30m")!;
    expect(Math.abs(d.getTime() - (Date.now() - 30 * 60 * 1000))).toBeLessThan(1000);
  });

  it("an RFC3339 instant → that exact instant", () => {
    expect(resolveReceivedAfter("2026-06-01T00:00:00Z")!.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  // BACKWARD COMPAT — a strict SUPERSET of the old lenient instant parse. parseSince's RFC3339 is stricter
  // than new Date (needs a full timestamp + zone), so a value it rejects must fall back to new Date rather
  // than 400 — otherwise a receivedAfter that worked before this PR breaks, and disagrees with the symmetric
  // receivedBefore (which still uses new Date).
  it("a date-only / no-timezone value still resolves (never 400s a value receivedBefore accepts)", () => {
    // date-only
    expect(resolveReceivedAfter("2026-07-01")).toEqual(new Date("2026-07-01"));
    // no timezone designator
    expect(resolveReceivedAfter("2026-07-01T12:00:00")).toEqual(new Date("2026-07-01T12:00:00"));
  });

  it("garbage → a VALIDATION_ERROR, never silently ignored", () => {
    expect(() => resolveReceivedAfter("last tuesday")).toThrow();
  });
});
