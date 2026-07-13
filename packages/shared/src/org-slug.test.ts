import { describe, expect, it } from "vitest";

import { ORG_SLUG_RESERVED, slugifyOrgName, suggestOrgSlug, validateOrgSlug } from "./org-slug";

// The slug rules live in the database as `orgs_slug_format` (a CHECK) + `org_slug_reserved` (a function,
// migration 0069). This module is the SAME rules in TypeScript, so the UI can validate a slug live and a
// server action can reject it with a friendly message BEFORE the round-trip — the DB stays the final authority.
// The `org-slug-parity.test.ts` real-Postgres test asserts these two never drift.

describe("validateOrgSlug", () => {
  it("accepts a well-formed slug", () => {
    for (const s of ["acme", "acme-corp", "a1b2c3", "team-42x", "a".repeat(40)]) {
      expect(validateOrgSlug(s), s).toMatchObject({ ok: true });
    }
  });

  it("rejects the shapes the DB CHECK rejects", () => {
    const bad: [string, string][] = [
      ["ab", "too short"],
      ["a".repeat(41), "too long"],
      ["-lead", "leading hyphen"],
      ["trail-", "trailing hyphen"],
      ["has space", "whitespace"],
      ["Under_score", "underscore"],
      ["MixedCase", "uppercase"],
      ["12345", "all-numeric"],
      ["acme--corp".replace("--", "-"), "ok control"], // sanity: this one is fine
    ];
    for (const [s, why] of bad.slice(0, -1)) {
      expect(validateOrgSlug(s), `${s} (${why})`).toMatchObject({ ok: false });
    }
  });

  it("rejects a reserved word, and names it as reserved (not just malformed)", () => {
    const res = validateOrgSlug("settings");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("reserved");
  });

  it("distinguishes the reason so the UI can say something useful", () => {
    const cases: [string, string][] = [
      ["ab", "too_short"],
      ["a".repeat(41), "too_long"],
      ["-x-", "format"],
      ["Ab-cd", "format"],
      ["999", "all_numeric"],
      ["billing", "reserved"],
    ];
    for (const [s, reason] of cases) {
      const r = validateOrgSlug(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason, s).toBe(reason);
    }
  });

  it("is case-insensitive about reserved words — DASHBOARD is still reserved", () => {
    // A reserved word must be caught before the format check would reject the uppercase, or `Dashboard` would
    // read as "just a formatting problem" and a user could think renaming to lowercase fixes it.
    expect(validateOrgSlug("Dashboard")).toMatchObject({ ok: false, reason: "reserved" });
  });
});

describe("slugifyOrgName — deriving a slug from a team name", () => {
  it("lowercases, hyphenates runs of non-alphanumerics, and trims", () => {
    expect(slugifyOrgName("Acme Corp")).toBe("acme-corp");
    expect(slugifyOrgName("  Hello, World!  ")).toBe("hello-world");
    expect(slugifyOrgName("Ünïcode")).toBe("n-code"); // the ï between n and code becomes a hyphen
  });

  it("caps the base length so a long name can't produce an over-length slug", () => {
    expect(slugifyOrgName("A".repeat(200)).length).toBeLessThanOrEqual(16);
  });

  it("returns '' when nothing survives — the caller supplies a fallback", () => {
    expect(slugifyOrgName("!!!")).toBe("");
    expect(slugifyOrgName("   ")).toBe("");
  });
});

describe("suggestOrgSlug — a VALID slug from a name, with a random disambiguating suffix", () => {
  it("produces a slug that passes validateOrgSlug", () => {
    for (const name of ["Acme", "!!!", "12345", "A".repeat(200), "settings", "ab"]) {
      const slug = suggestOrgSlug(name);
      expect(validateOrgSlug(slug), `${name} → ${slug}`).toMatchObject({ ok: true });
    }
  });

  it("never suggests a reserved word — 'settings' becomes 'settings-<suffix>'", () => {
    const slug = suggestOrgSlug("Settings");
    expect(slug).toMatch(/^settings-[0-9a-f]{6}$/);
    expect(validateOrgSlug(slug)).toMatchObject({ ok: true });
  });

  it("varies between calls for the same name, so a collision can be retried independently", () => {
    // The suffix is a CSPRNG draw, so two calls (re)draw independently. This is the property the retry loop
    // leans on; a deterministic suffix would make concurrent same-name creators contend for one ladder.
    const draws = new Set(Array.from({ length: 8 }, () => suggestOrgSlug("Acme")));
    expect(draws.size).toBeGreaterThan(1);
    for (const slug of draws) expect(validateOrgSlug(slug)).toMatchObject({ ok: true });
  });

  it("an all-numeric or empty name still yields a valid, non-numeric slug", () => {
    expect(validateOrgSlug(suggestOrgSlug("12345"))).toMatchObject({ ok: true });
    expect(validateOrgSlug(suggestOrgSlug(""))).toMatchObject({ ok: true });
  });
});

describe("ORG_SLUG_RESERVED", () => {
  it("is a frozen set covering the route segments a slug must never shadow", () => {
    for (const w of ["dashboard", "endpoints", "settings", "new", "org", "api", "billing"]) {
      expect(ORG_SLUG_RESERVED.has(w), w).toBe(true);
    }
  });
});
