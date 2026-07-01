import { PROVIDERS } from "@webhook-co/shared";
import { PROVIDER_DOMAINS, PROVIDER_LOGO_PATHS, providerIconDomain } from "@webhook-co/ui";
import { describe, expect, it } from "vitest";

// EVERY provider in the dropdown must resolve to a real logo, not a bare monogram. `ProviderLogo` resolves
// in three tiers: (1) a Simple Icons vector mark (PROVIDER_LOGO_PATHS), else (2) the brand favicon by domain
// (PROVIDER_DOMAINS), else (3) a monogram tile. This test — in apps/web, which owns the @webhook-co/shared
// dependency — proves tiers 1+2 cover the whole registry, so a NEW provider can't ship showing only initials
// without a deliberate opt-in to MONOGRAM_ONLY below. (Simple Icons dropped many brands over trademark
// policy — Slack/Twilio/LinkedIn/OpenAI… — which is exactly why the favicon tier exists.)

// Providers we consciously accept rendering as a monogram (no vector mark AND no sensible brand domain).
// Keep this EMPTY if at all possible; an entry here is a deliberate, reviewed decision, not a default.
const MONOGRAM_ONLY: ReadonlySet<string> = new Set<string>([]);

describe("provider logo completeness", () => {
  it("every registered provider resolves to a real logo (a vector mark OR a favicon domain)", () => {
    const monogramFallback = PROVIDERS.filter(
      (slug) =>
        !(slug in PROVIDER_LOGO_PATHS) && !(slug in PROVIDER_DOMAINS) && !MONOGRAM_ONLY.has(slug),
    );
    // A non-empty result means a source would show bare initials — add a Simple Icons mark, a
    // PROVIDER_DOMAINS favicon domain, or (deliberately) list it in MONOGRAM_ONLY.
    expect(monogramFallback).toEqual([]);
  });

  it("every vector mark is a non-empty SVG path + a valid hex (or null to tint with the brand colour)", () => {
    for (const [slug, mark] of Object.entries(PROVIDER_LOGO_PATHS)) {
      expect(mark.path.length, slug).toBeGreaterThan(10);
      // SVG path-data charset only — no angle brackets / quotes that could break out of the attribute.
      expect(mark.path, slug).toMatch(/^[-0-9.,\sA-Za-z]+$/);
      if (mark.hex !== null) expect(mark.hex, slug).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("PROVIDER_DOMAINS has no stale keys (every domain belongs to a real registered provider)", () => {
    const registry = new Set<string>(PROVIDERS);
    const stale = Object.keys(PROVIDER_DOMAINS).filter((slug) => !registry.has(slug));
    expect(stale).toEqual([]);
  });

  it("a favicon domain is only set for a LOGO-LESS provider (a vector mark always wins → no dead domains)", () => {
    const redundant = Object.keys(PROVIDER_DOMAINS).filter((slug) => slug in PROVIDER_LOGO_PATHS);
    expect(redundant).toEqual([]);
  });

  it("every favicon domain is a bare registrable host (no scheme, path, port, or spaces)", () => {
    for (const [slug, domain] of Object.entries(PROVIDER_DOMAINS)) {
      // At least two dot-separated labels, each label lowercase alnum/hyphen (no scheme/path/port/space).
      const labels = domain.split(".");
      expect(labels.length, slug).toBeGreaterThanOrEqual(2);
      for (const label of labels) expect(label, `${slug} label`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("MONOGRAM_ONLY has no stale entries and never overlaps a mark or a domain", () => {
    for (const slug of MONOGRAM_ONLY) {
      expect(PROVIDERS as readonly string[], slug).toContain(slug);
      expect(slug in PROVIDER_LOGO_PATHS, slug).toBe(false);
      expect(slug in PROVIDER_DOMAINS, slug).toBe(false);
    }
  });

  it("providerIconDomain resolves a logo-less slug to its domain, and null otherwise", () => {
    expect(providerIconDomain("twilio")).toBe("twilio.com");
    expect(providerIconDomain("stripe")).toBeNull(); // has a vector mark → no favicon domain
    expect(providerIconDomain(null)).toBeNull();
    expect(providerIconDomain("some_new_provider")).toBeNull();
  });
});
