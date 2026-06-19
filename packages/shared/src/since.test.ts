import { describe, expect, it } from "vitest";

import { parseSince } from "./since";

// parseSince is the PURE `--since` grammar parser, shared so the CLI validates identically to the
// server. It is a TOTAL function: every input returns a tagged result, never throws. RFC3339 parsing
// must be strict — `new Date()`/`Date.parse` silently mangle a no-zone string (→ local time) and a
// calendar overflow (`...-31` → next month), so the parser gates with a strict regex + a calendar check.

describe("parseSince — sentinels", () => {
  it("recognises now and beginning", () => {
    expect(parseSince("now")).toEqual({ kind: "now" });
    expect(parseSince("beginning")).toEqual({ kind: "beginning" });
  });

  it("is case-sensitive and rejects unknown words", () => {
    expect(parseSince("NOW").kind).toBe("invalid");
    expect(parseSince("latest").kind).toBe("invalid"); // never overload --latest (Stripe footgun)
    expect(parseSince("").kind).toBe("invalid");
  });
});

describe("parseSince — durations", () => {
  it("parses s/m/h/d units into milliseconds", () => {
    expect(parseSince("90s")).toEqual({ kind: "relative", ms: 90_000 });
    expect(parseSince("30m")).toEqual({ kind: "relative", ms: 30 * 60_000 });
    expect(parseSince("1h")).toEqual({ kind: "relative", ms: 3_600_000 });
    expect(parseSince("2d")).toEqual({ kind: "relative", ms: 2 * 86_400_000 });
    expect(parseSince("42m")).toEqual({ kind: "relative", ms: 42 * 60_000 });
  });

  it("rejects malformed or unsafe durations", () => {
    expect(parseSince("0m").kind).toBe("invalid"); // zero is meaningless (use `now`)
    expect(parseSince("-5m").kind).toBe("invalid"); // no negatives
    expect(parseSince("5").kind).toBe("invalid"); // missing unit
    expect(parseSince("5y").kind).toBe("invalid"); // unsupported unit
    expect(parseSince("1.5h").kind).toBe("invalid"); // no fractional
    expect(parseSince("9999999999999999999d").kind).toBe("invalid"); // not a safe integer
  });
});

describe("parseSince — RFC3339 timestamps (strict)", () => {
  it("accepts a zoned RFC3339 instant and returns the exact Date", () => {
    const r = parseSince("2026-06-17T00:00:00Z");
    expect(r.kind).toBe("timestamp");
    if (r.kind === "timestamp") {
      expect(r.date.toISOString()).toBe("2026-06-17T00:00:00.000Z");
    }
    // a numeric offset is a valid zone designator
    const off = parseSince("2026-06-17T00:00:00+02:00");
    expect(off.kind).toBe("timestamp");
    if (off.kind === "timestamp") {
      expect(off.date.toISOString()).toBe("2026-06-16T22:00:00.000Z");
    }
    // fractional seconds are allowed
    expect(parseSince("2026-06-17T00:00:00.250Z").kind).toBe("timestamp");
  });

  it("REJECTS a timestamp with no zone designator (would silently localise)", () => {
    expect(parseSince("2026-06-17T00:00:00").kind).toBe("invalid");
    expect(parseSince("2026-06-17").kind).toBe("invalid"); // date-only, no time/zone
  });

  it("REJECTS a calendar-overflow timestamp (Date would roll it into next month)", () => {
    expect(parseSince("2026-02-31T00:00:00Z").kind).toBe("invalid"); // Feb 31 doesn't exist
    expect(parseSince("2026-13-01T00:00:00Z").kind).toBe("invalid"); // month 13
    expect(parseSince("2026-06-17T25:00:00Z").kind).toBe("invalid"); // hour 25
  });

  it("never throws — every garbage input is a tagged invalid", () => {
    for (const bad of ["{}", "2026", "tomorrow", "1h30m", "  now  ", "nowish"]) {
      expect(parseSince(bad).kind).toBe("invalid");
    }
  });
});
