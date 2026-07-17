import { describe, expect, it } from "vitest";

import {
  firstParam,
  hasAppliedFilters,
  parseEventFilters,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  searchTooShort,
} from "./event-filters";

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
  it("passes provider(s) through as an array and drops blank/whitespace + missing values", () => {
    expect(parseEventFilters({ provider: "stripe" })).toEqual({ provider: ["stripe"] });
    // Multi-select: a repeated param arrives as a string[] → de-duped array.
    expect(parseEventFilters({ provider: ["stripe", "github", "stripe"] })).toEqual({
      provider: ["stripe", "github"],
    });
    expect(parseEventFilters({ provider: "  " })).toEqual({});
    expect(parseEventFilters({ provider: [] })).toEqual({});
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

  it("drops unknown provider members when validProviders is supplied (keeps the known ones)", () => {
    expect(parseEventFilters({ provider: ["github"] }, PROVIDERS)).toEqual({
      provider: ["github"],
    });
    // A hand-edited ?provider=foobar member is dropped; a known one alongside it survives.
    expect(parseEventFilters({ provider: ["foobar", "stripe"] }, PROVIDERS)).toEqual({
      provider: ["stripe"],
    });
    // All-unknown → no filter (not a confusing empty result).
    expect(parseEventFilters({ provider: "foobar" }, PROVIDERS)).toEqual({});
  });

  it("parses valid verification status(es) as an array and drops unknown members (closed enum)", () => {
    expect(parseEventFilters({ status: "failed" })).toEqual({ verificationState: ["failed"] });
    expect(parseEventFilters({ status: ["verified", "failed"] })).toEqual({
      verificationState: ["verified", "failed"],
    });
    expect(parseEventFilters({ status: ["bogus", "verified"] })).toEqual({
      verificationState: ["verified"],
    }); // junk member dropped
    expect(parseEventFilters({ status: "bogus" })).toEqual({}); // all junk → no filter
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

describe("parseEventFilters — endpointId (the org-wide browse's drill-down)", () => {
  const EP = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

  it("parses a uuid ?endpointId=", () => {
    expect(parseEventFilters({ endpointId: EP })).toEqual({ endpointId: EP });
  });

  // Shape-validated, NOT membership-validated — see the parser comment. A non-uuid must never reach SQL:
  // `endpoint_id = 'oops'` raises 22P02, which would turn a hand-edited URL into a 500.
  it("DROPS a non-uuid ?endpointId= so it never reaches SQL", () => {
    expect(parseEventFilters({ endpointId: "oops" })).toEqual({});
    expect(parseEventFilters({ endpointId: "" })).toEqual({});
  });

  it("takes the first value of a repeated ?endpointId=", () => {
    expect(parseEventFilters({ endpointId: [EP, "other"] })).toEqual({ endpointId: EP });
  });

  it("hasAppliedFilters counts an endpoint filter", () => {
    expect(hasAppliedFilters(parseEventFilters({ endpointId: EP }))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({ endpointId: "oops" }))).toBe(false);
  });
});

// REGRESSION (review of #640, found ON PROD). The org page defaults ?range to 7d when the reader has
// expressed no date intent. A bare `?? DEFAULT` was WRONG: picking a custom calendar range pushes
// `{from, to, range: ""}` — the two modes are mutually exclusive, so each clears the other — and with no
// ?range the default re-injected itself. The preset branch then OWNS the window and from/to are IGNORED, so
// a reader who picked Jan 1-9 saw the last 7 days while the chip read "Custom range".
//
// These pin the PARSER's half of that contract: a preset owns the range; from/to apply only without one.
describe("parseEventFilters — a preset OWNS the range (why the page must not blanket-default it)", () => {
  it("a preset DISCARDS from/to entirely", () => {
    const f = parseEventFilters({ range: "7d", from: "2026-01-01", to: "2026-01-10" });
    expect(f.receivedBefore).toBeUndefined(); // `to` silently dropped — the page must not cause this
    expect(f.receivedAfter).toBeDefined();
  });

  it("without a preset, from/to are honoured", () => {
    const f = parseEventFilters({ from: "2026-01-01", to: "2026-01-10" });
    expect(f.receivedAfter).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(f.receivedBefore).toEqual(new Date("2026-01-10T00:00:00.000Z"));
  });
});

describe("parseEventFilters — the search floor (pg_trgm needs 3 chars)", () => {
  // Below 3 chars pg_trgm extracts NO trigrams, so `%ab%` returns everything from the GIN and rechecks it —
  // unservable by any index, at any volume. Matches the contract's .min(3) so the four surfaces agree.
  it("DROPS a term shorter than 3 characters", () => {
    expect(parseEventFilters({ search: "a" })).toEqual({});
    expect(parseEventFilters({ search: "ab" })).toEqual({});
  });

  it("keeps a 3-character term", () => {
    expect(parseEventFilters({ search: "abc" })).toEqual({ search: "abc" });
  });

  // The uuid short-circuit is unaffected — it resolves by PK, not by trigram.
  it("keeps a full uuid (the paste-an-id-to-jump-to-it path)", () => {
    const id = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";
    expect(parseEventFilters({ search: id })).toEqual({ search: id });
  });
});

// A DROPPED TERM MUST BE VISIBLE, not silent.
//
// The 3-char floor is real (pg_trgm extracts zero trigrams below it), but dropping a short term silently is a
// UX cliff: typing "ab" applied NO filter, so the reader saw every event in the org and had to infer that
// their search hadn't run. Worse, hasAppliedFilters went false, so the page could show onboarding copy in
// response to a search. The same term 400s on API/CLI/MCP — web was the only surface that pretended.
//
// The filter is still not RUN (that part was right). What changes is that the caller can now TELL, and say so.
describe("a below-floor search term is reported, not silently swallowed", () => {
  it("does not run the filter, but reports the term as too short", () => {
    const parsed = parseEventFilters({ search: "ab" }, ["stripe"]);
    expect(parsed.search).toBeUndefined();
    expect(searchTooShort({ search: "ab" })).toBe(true);
  });

  it("is false for a term that actually runs, and for no term at all", () => {
    expect(searchTooShort({ search: "abc" })).toBe(false);
    expect(searchTooShort({ search: "" })).toBe(false);
    expect(searchTooShort({})).toBe(false);
    // Whitespace-only is "no search", not "too short" — it must not nag someone who typed a space.
    expect(searchTooShort({ search: "  " })).toBe(false);
  });

  it("counts the TRIMMED term, matching the contract's .trim().min(3)", () => {
    expect(searchTooShort({ search: " ab " })).toBe(true);
    expect(searchTooShort({ search: " abc " })).toBe(false);
  });
});

// THE DRIFT GUARD for a value duplicated across a bundling boundary.
//
// event-filters.ts declares the search bounds rather than importing them: it is client-imported, and the
// contract's constants sit alongside every zod schema (importing them would ship the schemas to the browser),
// while the contract BARREL's `export *` resolves to undefined under Turbopack — a runtime 500, not a build
// error. So the mirror is deliberate, and this test is the thing that keeps it honest. It runs in node, where
// importing the contract is free and safe.
//
// If this fails, the API and the web now disagree about the floor: web would silently drop a term the API
// accepts, or forward one it 400s.
describe("the web's search bounds match the contract's", () => {
  it("mirrors SEARCH_MIN_LENGTH / SEARCH_MAX_LENGTH exactly", async () => {
    const contract = await import("@webhook-co/contract");
    expect(SEARCH_MIN_LENGTH).toBe(contract.SEARCH_MIN_LENGTH);
    expect(SEARCH_MAX_LENGTH).toBe(contract.SEARCH_MAX_LENGTH);
  });

  // And the constants must be the ones the SHIPPED schema enforces — not merely two numbers that agree with
  // each other while the schema hardcodes something else.
  it("is the floor the contract's schema actually enforces", async () => {
    const { eventsList } = await import("@webhook-co/contract");
    const schema = eventsList.input;
    const tooShort = schema.safeParse({
      endpointId: crypto.randomUUID(),
      filter: { search: "ab" },
    });
    const longEnough = schema.safeParse({
      endpointId: crypto.randomUUID(),
      filter: { search: "abc" },
    });
    expect(tooShort.success).toBe(false);
    expect(longEnough.success).toBe(true);
  });
});

describe("parseEventFilters — the new facets (method, eventType, dedupStrategy)", () => {
  it("method: multi-select, validated against the 7 verbs; junk dropped", () => {
    expect(parseEventFilters({ method: ["GET", "POST"] }).method).toEqual(["GET", "POST"]);
    expect(parseEventFilters({ method: "GET" }).method).toEqual(["GET"]);
    // a hand-edited bad verb is dropped, not passed to SQL; de-duped
    expect(parseEventFilters({ method: ["GET", "TRACE", "GET"] }).method).toEqual(["GET"]);
    expect(parseEventFilters({ method: "nope" }).method).toBeUndefined();
    expect(parseEventFilters({ method: [] }).method).toBeUndefined();
  });

  it("dedupStrategy: multi-select, validated against the 5 strategies; junk dropped", () => {
    expect(parseEventFilters({ dedupStrategy: ["unique", "content_hash"] }).dedupStrategy).toEqual([
      "unique",
      "content_hash",
    ]);
    expect(parseEventFilters({ dedupStrategy: "bogus" }).dedupStrategy).toBeUndefined();
  });

  it("eventType: a single trimmed string (exact match); empty/whitespace dropped", () => {
    expect(parseEventFilters({ eventType: "charge.succeeded" }).eventType).toBe("charge.succeeded");
    expect(parseEventFilters({ eventType: "  invoice.paid  " }).eventType).toBe("invoice.paid");
    expect(parseEventFilters({ eventType: "   " }).eventType).toBeUndefined();
    expect(parseEventFilters({ eventType: "" }).eventType).toBeUndefined();
    // a repeated param takes first-wins (never throws on an array)
    expect(parseEventFilters({ eventType: ["a.b", "c.d"] }).eventType).toBe("a.b");
    // an over-long value is dropped (mirrors the contract's max 256)
    expect(parseEventFilters({ eventType: "x".repeat(257) }).eventType).toBeUndefined();
  });

  it("hasAppliedFilters is true when any new facet is set", () => {
    expect(hasAppliedFilters(parseEventFilters({ method: ["GET"] }))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({ dedupStrategy: ["unique"] }))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({ eventType: "charge.succeeded" }))).toBe(true);
    expect(hasAppliedFilters(parseEventFilters({}))).toBe(false);
  });
});
