import { describe, expect, it } from "vitest";

import {
  activeDateLabel,
  ALL_TIME_RANGE,
  DATE_PRESETS,
  DEFAULT_ORG_EVENTS_RANGE,
  effectiveDateRange,
  hasDateRange,
  isDateIntent,
  isDatePreset,
  presetCalendarRange,
  presetLabel,
  resolvePresetBound,
} from "./date-range";

// A fixed clock so preset resolution is deterministic.
const NOW = new Date("2026-06-29T12:00:00.000Z");

describe("DATE_PRESETS", () => {
  it("exposes the four relative presets, newest window first", () => {
    expect(DATE_PRESETS.map((p) => p.id)).toEqual(["1h", "24h", "7d", "30d"]);
  });
});

describe("isDatePreset", () => {
  it("accepts a known id and rejects everything else", () => {
    expect(isDatePreset("7d")).toBe(true);
    expect(isDatePreset("foo")).toBe(false);
    expect(isDatePreset("")).toBe(false);
    expect(isDatePreset(null)).toBe(false);
    expect(isDatePreset(undefined)).toBe(false);
  });
});

describe("resolvePresetBound", () => {
  it("resolves a preset to now minus its window", () => {
    expect(resolvePresetBound("1h", NOW)?.toISOString()).toBe("2026-06-29T11:00:00.000Z");
    expect(resolvePresetBound("24h", NOW)?.toISOString()).toBe("2026-06-28T12:00:00.000Z");
    expect(resolvePresetBound("7d", NOW)?.toISOString()).toBe("2026-06-22T12:00:00.000Z");
    expect(resolvePresetBound("30d", NOW)?.toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });

  it("returns undefined for an unknown id (a hand-edited ?range=foo is ignored)", () => {
    expect(resolvePresetBound("foo", NOW)).toBeUndefined();
    expect(resolvePresetBound(null, NOW)).toBeUndefined();
  });
});

describe("presetCalendarRange", () => {
  it("resolves a preset to its [day of (now − window), today] calendar span (UTC)", () => {
    // For highlighting the active preset in the grid.
    expect(presetCalendarRange("7d", NOW)).toEqual({ from: "2026-06-22", to: "2026-06-29" });
    expect(presetCalendarRange("30d", NOW)).toEqual({ from: "2026-05-30", to: "2026-06-29" });
    // Sub-day presets collapse onto the current day(s): 1h stays today, 24h reaches back one calendar day.
    expect(presetCalendarRange("1h", NOW)).toEqual({ from: "2026-06-29", to: "2026-06-29" });
    expect(presetCalendarRange("24h", NOW)).toEqual({ from: "2026-06-28", to: "2026-06-29" });
  });

  it("returns an empty range for an unknown preset id", () => {
    expect(presetCalendarRange("foo", NOW)).toEqual({});
  });
});

describe("presetLabel", () => {
  it("maps a known id to its label and an unknown id to undefined", () => {
    expect(presetLabel("7d")).toBe("Last 7 days");
    expect(presetLabel("foo")).toBeUndefined();
  });
});

describe("activeDateLabel", () => {
  it("prefers the preset label when a valid preset is set", () => {
    expect(activeDateLabel({ range: "24h" })).toBe("Last 24 hours");
    // A valid preset wins even if stray from/to ride along.
    expect(activeDateLabel({ range: "7d", from: "2026-06-01", to: "2026-06-08" })).toBe(
      "Last 7 days",
    );
  });

  it("labels any custom from/to as 'Custom range' (the inline inputs show the actual dates)", () => {
    // No date summary in the label — it would duplicate the always-visible inputs and would have to
    // encode the exclusive-`to` semantics (which a plain "Jun 1 – Jun 8" cannot convey honestly).
    expect(activeDateLabel({ from: "2026-06-01", to: "2026-06-08" })).toBe("Custom range");
    expect(activeDateLabel({ from: "2026-06-01" })).toBe("Custom range");
    expect(activeDateLabel({ to: "2026-06-08" })).toBe("Custom range");
  });

  it("falls back to a neutral prompt when nothing is set", () => {
    expect(activeDateLabel({})).toBe("Date range");
    expect(activeDateLabel({ range: "foo" })).toBe("Date range");
    expect(activeDateLabel({ from: "", to: "" })).toBe("Date range");
    // A valid preset still wins over stray custom dates.
    expect(activeDateLabel({ range: "7d", from: "2026-06-01" })).toBe("Last 7 days");
  });
});

describe("hasDateRange", () => {
  it("is true for a valid preset or a non-empty custom bound, false when nothing is set", () => {
    expect(hasDateRange({ range: "7d" })).toBe(true);
    expect(hasDateRange({ from: "2026-06-01" })).toBe(true);
    expect(hasDateRange({ to: "2026-06-08" })).toBe(true);
    expect(hasDateRange({})).toBe(false);
    expect(hasDateRange({ range: "foo" })).toBe(false); // unknown preset, no custom dates
    expect(hasDateRange({ range: "", from: "", to: "" })).toBe(false);
  });
});

// THE BUG: the 7d default was inescapable, and the code CLAIMED otherwise.
//
// date-range.ts asserted `"Any time" is one click away — never a silent filter`, and I repeated it in the
// page comment and the PR. It was false three times over: DATE_PRESETS is 1h/24h/7d/30d and NOTHING in the
// menu cleared the range, so no click reached all-time. The default was exactly the silent filter the comment
// swore it wasn't.
//
// It also cannot be fixed by adding a button that clears the params. applyPatch DELETES a key on an empty
// value (events-filter-bar.tsx), and the page defaults when the params are ABSENT — so "clear the range"
// round-trips straight back to 7d. That is the same trap that already shipped once, when a custom calendar
// range pushed `range: ""` and the default re-injected itself over the user's dates.
//
// So all-time needs an EXPLICIT token that survives the URL: `?range=all`.
describe("ALL_TIME_RANGE — the escape hatch that must survive a round trip", () => {
  it("is not a window preset (it resolves to no bound at all)", () => {
    expect(isDatePreset(ALL_TIME_RANGE)).toBe(false);
    expect(resolvePresetBound(ALL_TIME_RANGE, new Date())).toBeUndefined();
  });

  it("is a RECOGNISED date intent — the thing an absent param is not", () => {
    // This is the whole fix. `?range=all` is present and non-empty, so applyPatch SETS it rather than
    // deleting it, the page sees date intent, and the default never re-injects.
    expect(isDateIntent(ALL_TIME_RANGE)).toBe(true);
    expect(isDateIntent("7d")).toBe(true);
    // Absent or empty is NOT an intent — that is precisely what the default exists to fill.
    expect(isDateIntent("")).toBe(false);
    expect(isDateIntent(null)).toBe(false);
    expect(isDateIntent(undefined)).toBe(false);
    // A hand-edited junk value is not an intent either — it must fall back to the default, not to all-time.
    expect(isDateIntent("bogus")).toBe(false);
  });

  it('labels the trigger "Any time" so the chip never lies about the window', () => {
    expect(activeDateLabel({ range: ALL_TIME_RANGE })).toBe("Any time");
  });

  it("counts as an active date choice (so the bar can offer to clear it)", () => {
    expect(hasDateRange({ range: ALL_TIME_RANGE })).toBe(true);
  });
});

// ONE rule, both callers. The page resolved the default server-side while the filter bar read the URL — two
// independent decisions about the same window, so they disagreed the moment the URL had no `?range=`: the
// page filtered to 7 days and the chip read a generic "Date range". The default was a SILENT filter, which is
// exactly what date-range.ts swore it wasn't ("the chip shows it"). An e2e caught it; no unit test could,
// because each side was individually correct.
describe("effectiveDateRange — the single source of truth for the applied window", () => {
  const D = DEFAULT_ORG_EVENTS_RANGE;

  it("applies the fallback ONLY when no date choice was made", () => {
    expect(effectiveDateRange({}, D)).toBe(D);
    expect(effectiveDateRange({ range: "" }, D)).toBe(D);
    expect(effectiveDateRange({ range: null, from: "", to: "" }, D)).toBe(D);
  });

  it("a preset or the all-time token wins over the fallback", () => {
    expect(effectiveDateRange({ range: "1h" }, D)).toBe("1h");
    expect(effectiveDateRange({ range: ALL_TIME_RANGE }, D)).toBe(ALL_TIME_RANGE);
  });

  // THE BUG THIS SHAPE PREVENTS. A custom range pushes `{from, to, range: ""}`, so a naive `range || fallback`
  // resolves to the fallback and the reader sees 7 days while the chip says "Custom range". That exact bug
  // already shipped to prod once.
  it("a custom from/to suppresses the fallback entirely", () => {
    expect(effectiveDateRange({ range: "", from: "2026-01-01", to: "2026-01-09" }, D)).toBe("");
    expect(effectiveDateRange({ from: "2026-01-01" }, D)).toBe("");
    expect(effectiveDateRange({ to: "2026-01-09" }, D)).toBe("");
  });

  it("junk falls back to the default — a typo must never widen to all-time", () => {
    expect(effectiveDateRange({ range: "bogus" }, D)).toBe(D);
  });
});

// PRECEDENCE MUST MIRROR THE PARSER — this is the chip-vs-data lie, one more time.
//
// parseEventFilters resolves in a fixed order: a valid PRESET owns the window; otherwise from/to apply. The
// all-time token is NOT a preset, so from/to beat it. The label and the effective range must agree with that
// exactly, or the chip describes a window the reader is not looking at. This lane has now shipped that bug
// twice, and the first version of ALL_TIME_RANGE made it a third: `?range=all&from=X&to=Y` labelled
// "Any time" while the list was bounded to X..Y.
describe("range=all vs a custom from/to — from/to wins, and the chip must say so", () => {
  const D = DEFAULT_ORG_EVENTS_RANGE;

  it("a custom from/to beats the all-time token (mirroring parseEventFilters)", () => {
    expect(
      effectiveDateRange({ range: ALL_TIME_RANGE, from: "2026-01-01", to: "2026-01-09" }, D),
    ).toBe("");
    expect(activeDateLabel({ range: ALL_TIME_RANGE, from: "2026-01-01", to: "2026-01-09" })).toBe(
      "Custom range",
    );
  });

  it("a preset still beats a custom from/to (unchanged)", () => {
    expect(effectiveDateRange({ range: "7d", from: "2026-01-01" }, D)).toBe("7d");
    expect(activeDateLabel({ range: "7d", from: "2026-01-01" })).toBe("Last 7 days");
  });

  it("all-time alone still resolves and labels as all-time", () => {
    expect(effectiveDateRange({ range: ALL_TIME_RANGE }, D)).toBe(ALL_TIME_RANGE);
    expect(activeDateLabel({ range: ALL_TIME_RANGE })).toBe("Any time");
  });
});
