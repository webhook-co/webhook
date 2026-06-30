import { PROVIDERS } from "@webhook-co/shared";
import { PROVIDER_BRANDING, providerBrandColor, providerDisplayName } from "@webhook-co/ui";
import { describe, expect, it } from "vitest";

// The branding map lives in @webhook-co/ui keyed by plain string (so ui stays a client-safe leaf). This
// test — in apps/web, which owns the @webhook-co/shared dependency — proves it COVERS every registry slug,
// so a new provider added to PROVIDERS can't ship without its display name + brand colour.

describe("provider branding completeness", () => {
  it("has an entry for every registered provider slug", () => {
    const missing = PROVIDERS.filter((slug) => !(slug in PROVIDER_BRANDING));
    expect(missing).toEqual([]);
  });

  it("every entry is a non-empty display name + a 6-digit hex brand colour", () => {
    for (const slug of PROVIDERS) {
      const brand = PROVIDER_BRANDING[slug]!;
      expect(brand.displayName.length, slug).toBeGreaterThan(0);
      expect(brand.brandColor, slug).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("resolves names: known slug → display name, null → placeholder, unknown → humanised", () => {
    expect(providerDisplayName("stripe")).toBe("Stripe");
    expect(providerDisplayName("mercado_pago")).toBe("Mercado Pago");
    expect(providerDisplayName(null)).toBe("—");
    // Forward-compatible: a future slug not yet branded still renders sensibly.
    expect(providerDisplayName("some_new_provider")).toBe("Some New Provider");
  });

  it("resolves brand colours with a neutral fallback for unknown/null", () => {
    expect(providerBrandColor("stripe")).toBe("#635BFF");
    expect(providerBrandColor("some_new_provider")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(providerBrandColor(null)).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
