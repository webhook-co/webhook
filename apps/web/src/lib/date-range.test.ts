import { describe, expect, it } from "vitest";

import {
  activeDateLabel,
  DATE_PRESETS,
  hasDateRange,
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
