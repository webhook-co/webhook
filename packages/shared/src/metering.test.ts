import { describe, expect, it } from "vitest";

import {
  currentBillingPeriod,
  finalizeCutoff,
  ingestAllowed,
  parseFreeEventCap,
  rollupWindows,
  shouldPauseForCap,
  type IngestGuardSignal,
} from "./metering";

describe("parseFreeEventCap (Free-tier default cap, fail-safe)", () => {
  it("accepts a clean positive integer", () => {
    expect(parseFreeEventCap("500000")).toBe(500000);
    expect(parseFreeEventCap("1")).toBe(1);
  });

  it("treats unset / blank / whitespace as uncapped (null)", () => {
    expect(parseFreeEventCap(undefined)).toBeNull();
    expect(parseFreeEventCap(null)).toBeNull();
    expect(parseFreeEventCap("")).toBeNull();
    expect(parseFreeEventCap("   ")).toBeNull();
  });

  it("treats 0 and negatives as uncapped, NEVER as cap-at-0 (would mass-pause every Free org)", () => {
    // shouldPauseForCap(usage, 0, 'pause') is usage >= 0 = always true — a 0 cap must fail safe.
    expect(parseFreeEventCap("0")).toBeNull();
    expect(parseFreeEventCap("-1")).toBeNull();
    expect(parseFreeEventCap("-500000")).toBeNull();
  });

  it("rejects lenient/partial strings instead of taking a parseInt prefix", () => {
    expect(parseFreeEventCap("10k")).toBeNull();
    expect(parseFreeEventCap("1e6")).toBeNull();
    expect(parseFreeEventCap("1_000")).toBeNull();
    expect(parseFreeEventCap("100abc")).toBeNull();
    expect(parseFreeEventCap("1.5")).toBeNull();
    expect(parseFreeEventCap("+500")).toBeNull();
    expect(parseFreeEventCap("0x10")).toBeNull();
    expect(parseFreeEventCap("NaN")).toBeNull();
    expect(parseFreeEventCap("Infinity")).toBeNull();
  });

  it("rejects a value beyond the safe-integer range", () => {
    expect(parseFreeEventCap("9".repeat(30))).toBeNull();
  });

  it("tolerates surrounding whitespace on an otherwise-clean integer", () => {
    expect(parseFreeEventCap("  500000  ")).toBe(500000);
  });
});

describe("ingestAllowed", () => {
  const base: IngestGuardSignal = { orgId: "o", paused: false, eventCap: 1000 };

  it("allows when not paused", () => {
    expect(ingestAllowed(base)).toBe(true);
  });

  it("blocks when paused", () => {
    expect(ingestAllowed({ ...base, paused: true })).toBe(false);
  });
});

describe("shouldPauseForCap (soft-cap)", () => {
  it("pauses at or over the cap under the 'pause' policy", () => {
    expect(shouldPauseForCap(999, 1000, "pause")).toBe(false);
    expect(shouldPauseForCap(1000, 1000, "pause")).toBe(true);
    expect(shouldPauseForCap(1001, 1000, "pause")).toBe(true);
  });

  it("never pauses under the 'allow' policy", () => {
    expect(shouldPauseForCap(5000, 1000, "allow")).toBe(false);
  });

  it("never pauses an uncapped org", () => {
    expect(shouldPauseForCap(1_000_000, null, "pause")).toBe(false);
  });
});

// The rollup scheduler must (F2) re-roll the just-closed day, not only "today", or it
// loses the pre-midnight tail every day. And (F4) all windows are UTC-day-aligned so the
// bucket key can't drift with server TZ. These pure helpers decide WHICH day-windows a
// run touches and WHEN a day is frozen — off the hot path, deterministic, unit-tested.

describe("rollupWindows", () => {
  const now = Date.UTC(2026, 6, 7, 10, 30, 0); // 2026-07-07T10:30:00Z

  it("returns today plus `settleDays` prior UTC-midnight windows, oldest→newest", () => {
    expect(rollupWindows(now, 2)).toEqual([
      "2026-07-05T00:00:00.000Z",
      "2026-07-06T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z",
    ]);
  });

  it("with settleDays=1 rolls yesterday + today (the F2 minimum)", () => {
    expect(rollupWindows(now, 1)).toEqual(["2026-07-06T00:00:00.000Z", "2026-07-07T00:00:00.000Z"]);
  });

  it("aligns to UTC midnight regardless of the intra-day time", () => {
    const lateNight = Date.UTC(2026, 6, 7, 23, 59, 59, 999);
    expect(rollupWindows(lateNight, 1)).toEqual([
      "2026-07-06T00:00:00.000Z",
      "2026-07-07T00:00:00.000Z",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    const firstOfMonth = Date.UTC(2026, 7, 1, 3, 0, 0); // 2026-08-01T03:00Z
    expect(rollupWindows(firstOfMonth, 1)).toEqual([
      "2026-07-31T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });
});

describe("currentBillingPeriod", () => {
  it("returns the UTC calendar-month bounds containing `now` (the default anchor)", () => {
    expect(currentBillingPeriod(Date.UTC(2026, 6, 7, 12, 0, 0))).toEqual({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z",
    });
  });

  it("is half-open [start, end): the last instant of the month is still this period", () => {
    expect(currentBillingPeriod(Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toEqual({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z",
    });
  });

  it("rolls the year at December", () => {
    expect(currentBillingPeriod(Date.UTC(2026, 11, 15, 8, 0, 0))).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("finalizeCutoff", () => {
  const now = Date.UTC(2026, 6, 7, 10, 30, 0); // 2026-07-07T10:30:00Z

  it("freezes days strictly older than settleDays before today (UTC midnight)", () => {
    // settleDays=2 → cutoff = start-of-today − 2 days = 2026-07-05T00:00Z.
    // Days with window_start < cutoff (07-04 and earlier) finalize; 07-05/06/07 stay open.
    expect(finalizeCutoff(now, 2)).toBe("2026-07-05T00:00:00.000Z");
  });

  it("the finalize cutoff equals the oldest still-rolled window (no open-but-unrolled gap)", () => {
    // Invariant: every day at-or-after the cutoff is still being rolled, so a day is only
    // frozen once it has stopped being recounted. Cutoff == rollupWindows(...)[0].
    for (const settleDays of [1, 2, 3, 7]) {
      const windows = rollupWindows(now, settleDays);
      expect(finalizeCutoff(now, settleDays)).toBe(windows[0]);
    }
  });
});
