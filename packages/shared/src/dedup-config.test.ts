import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  clampDedupWindow,
  DEDUP_MODES,
  DedupConfigSchema,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  isDedupWindowInRange,
  MAX_DEDUP_WINDOW_SECONDS,
  MAX_FIELD_PATHS,
  MAX_PATH_SEGMENTS,
  MIN_DEDUP_WINDOW_SECONDS,
  parseFieldPath,
} from "./dedup-config";

// ---------------------------------------------------------------------------
// parseFieldPath — the pure grammar parser + validator that gates config writes.
// A path names ONE keyable location: `path` (the request path), `headers.<name>`,
// `query.<name>`, or `body.<dot-path>` with array `[n]` / `[*]` accessors. Anything
// malformed MUST be rejected here (config-write time), never at ingest time.
// ---------------------------------------------------------------------------
describe("parseFieldPath — grammar", () => {
  it("accepts the four roots", () => {
    expect(parseFieldPath("path").ok).toBe(true);
    expect(parseFieldPath("headers.x-request-id").ok).toBe(true);
    expect(parseFieldPath("query.name").ok).toBe(true);
    expect(parseFieldPath("body.id").ok).toBe(true);
  });

  it("parses a nested body path into segments", () => {
    const r = parseFieldPath("body.data.object.id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.root).toBe("body");
      expect(r.parsed.segments).toEqual([{ key: "data" }, { key: "object" }, { key: "id" }]);
    }
  });

  it("parses array index and wildcard accessors on body paths", () => {
    const idx = parseFieldPath("body.items[0].sku");
    expect(idx.ok).toBe(true);
    if (idx.ok)
      expect(idx.parsed.segments).toEqual([{ key: "items" }, { index: 0 }, { key: "sku" }]);
    const wild = parseFieldPath("body.items[*].sku");
    expect(wild.ok).toBe(true);
    if (wild.ok)
      expect(wild.parsed.segments).toEqual([{ key: "items" }, { wildcard: true }, { key: "sku" }]);
  });

  it("rejects an unknown root", () => {
    expect(parseFieldPath("cookies.session").ok).toBe(false);
    expect(parseFieldPath("bodyy.id").ok).toBe(false);
    expect(parseFieldPath("").ok).toBe(false);
  });

  it("rejects `path` with any sub-segments (it names the whole path)", () => {
    expect(parseFieldPath("path.foo").ok).toBe(false);
    expect(parseFieldPath("path[0]").ok).toBe(false);
  });

  it("rejects array accessors on headers/query (flat key spaces)", () => {
    expect(parseFieldPath("headers.x[0]").ok).toBe(false);
    expect(parseFieldPath("query.a[*]").ok).toBe(false);
  });

  it("rejects an empty header/query name", () => {
    expect(parseFieldPath("headers.").ok).toBe(false);
    expect(parseFieldPath("query.").ok).toBe(false);
  });

  it("enforces the segment-count cap", () => {
    const deep =
      "body." + Array.from({ length: MAX_PATH_SEGMENTS + 1 }, (_, i) => `s${i}`).join(".");
    expect(parseFieldPath(deep).ok).toBe(false);
    const ok = "body." + Array.from({ length: MAX_PATH_SEGMENTS - 1 }, (_, i) => `s${i}`).join(".");
    expect(parseFieldPath(ok).ok).toBe(true);
  });

  it("rejects out-of-range and malformed array indices", () => {
    expect(parseFieldPath("body.a[101]").ok).toBe(false); // > max index
    expect(parseFieldPath("body.a[-1]").ok).toBe(false);
    expect(parseFieldPath("body.a[]").ok).toBe(false);
    expect(parseFieldPath("body.a[1.5]").ok).toBe(false);
    expect(parseFieldPath("body.a[").ok).toBe(false);
  });

  it("rejects a bare `body` with no field selected", () => {
    // `body` alone is the whole payload — that is `content` mode, not a field selector.
    expect(parseFieldPath("body").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DedupConfigSchema — the per-endpoint config object. Must stay z.toJSONSchema-clean
// (no z.coerce / .transform) so the contract build-gate + MCP tool schema survive.
// ---------------------------------------------------------------------------
describe("DedupConfigSchema", () => {
  it("accepts each mode", () => {
    for (const mode of DEDUP_MODES) {
      const base =
        mode === "fields"
          ? { mode, windowSeconds: 3600, fields: { include: ["body.id"] } }
          : { mode, windowSeconds: 3600 };
      expect(DedupConfigSchema.safeParse(base).success).toBe(true);
    }
  });

  it("bounds windowSeconds to [60, 604800]", () => {
    expect(DedupConfigSchema.safeParse({ mode: "identifier", windowSeconds: 59 }).success).toBe(
      false,
    );
    expect(
      DedupConfigSchema.safeParse({ mode: "identifier", windowSeconds: 604_801 }).success,
    ).toBe(false);
    expect(DedupConfigSchema.safeParse({ mode: "identifier", windowSeconds: 60 }).success).toBe(
      true,
    );
  });

  it("requires a non-empty include list for `fields` mode", () => {
    expect(DedupConfigSchema.safeParse({ mode: "fields", windowSeconds: 3600 }).success).toBe(
      false,
    );
    expect(
      DedupConfigSchema.safeParse({ mode: "fields", windowSeconds: 3600, fields: { include: [] } })
        .success,
    ).toBe(false);
  });

  it("rejects `fields` for a non-fields mode", () => {
    expect(
      DedupConfigSchema.safeParse({
        mode: "identifier",
        windowSeconds: 3600,
        fields: { include: ["body.id"] },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed field paths via the grammar", () => {
    expect(
      DedupConfigSchema.safeParse({
        mode: "fields",
        windowSeconds: 3600,
        fields: { include: ["cookies.session"] },
      }).success,
    ).toBe(false);
  });

  it("enforces the field-path count cap", () => {
    const tooMany = Array.from({ length: MAX_FIELD_PATHS + 1 }, (_, i) => `body.f${i}`);
    expect(
      DedupConfigSchema.safeParse({
        mode: "fields",
        windowSeconds: 3600,
        fields: { include: tooMany },
      }).success,
    ).toBe(false);
  });

  it("stays JSON-Schema-serializable (no coerce/transform in the input)", () => {
    // Mirrors the contract build-gate: a coerce/transform would throw here.
    expect(() => z.toJSONSchema(DedupConfigSchema)).not.toThrow();
  });
});

describe("dedup window helpers (shared by every UI surface)", () => {
  it("isDedupWindowInRange accepts whole seconds inside [60, 604800] only", () => {
    expect(isDedupWindowInRange(MIN_DEDUP_WINDOW_SECONDS)).toBe(true);
    expect(isDedupWindowInRange(MAX_DEDUP_WINDOW_SECONDS)).toBe(true);
    expect(isDedupWindowInRange("3600")).toBe(true);
    // out of range, empty, fractional, non-numeric → false (so a form rejects rather than silently clamps)
    expect(isDedupWindowInRange(10)).toBe(false);
    expect(isDedupWindowInRange(MAX_DEDUP_WINDOW_SECONDS + 1)).toBe(false);
    expect(isDedupWindowInRange("")).toBe(false);
    expect(isDedupWindowInRange("  ")).toBe(false);
    expect(isDedupWindowInRange("60.5")).toBe(false);
    expect(isDedupWindowInRange("abc")).toBe(false);
  });

  it("clampDedupWindow rounds + clamps into range, defaulting a blank/non-numeric entry", () => {
    expect(clampDedupWindow("3600")).toBe(3600);
    expect(clampDedupWindow(10)).toBe(MIN_DEDUP_WINDOW_SECONDS);
    expect(clampDedupWindow(MAX_DEDUP_WINDOW_SECONDS + 100)).toBe(MAX_DEDUP_WINDOW_SECONDS);
    expect(clampDedupWindow("120.4")).toBe(120);
    expect(clampDedupWindow("")).toBe(DEFAULT_DEDUP_WINDOW_SECONDS);
    expect(clampDedupWindow("abc")).toBe(DEFAULT_DEDUP_WINDOW_SECONDS);
  });
});
