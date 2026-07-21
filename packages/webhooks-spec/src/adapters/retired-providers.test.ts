import { describe, expect, it } from "vitest";

import {
  canonicalProvider,
  PROVIDERS,
  ProviderSchema,
  RETIRED_PROVIDER_ALIASES,
  RETIRED_PROVIDERS,
} from "./config";

// Retiring a slug is not a vocabulary edit — the slug is already sitting in `provider_secrets.provider`
// and `events.provider`, both plain `text`. The engine picks an adapter from the REGISTERED provider, so
// a slug that stops resolving doesn't error: verification silently stops and events start landing
// unverified. `canonicalProvider` is the single place that turns stored free text into a live Provider,
// which is why the alias belongs there and not in a schema at the API edge.

describe("retired provider slugs", () => {
  it("every alias maps a dead slug onto a LIVE provider (zero-input floor)", () => {
    const aliases = Object.entries(RETIRED_PROVIDER_ALIASES);
    expect(
      aliases.length,
      "no retired slugs recorded — is this file still needed?",
    ).toBeGreaterThan(0);
    for (const [dead, live] of aliases) {
      expect(
        (PROVIDERS as readonly string[]).includes(dead),
        `${dead} is retired but still in PROVIDERS`,
      ).toBe(false);
      expect(
        (PROVIDERS as readonly string[]).includes(live),
        `${dead} points at ${live}, which is not a live provider`,
      ).toBe(true);
    }
  });

  it("RETIRED_PROVIDERS is exactly the alias keys — one list, not two that can disagree", () => {
    expect([...RETIRED_PROVIDERS].sort()).toEqual(Object.keys(RETIRED_PROVIDER_ALIASES).sort());
  });

  it("the write path still REJECTS a retired slug — nothing new registers under it", () => {
    for (const dead of RETIRED_PROVIDERS) {
      expect(ProviderSchema.safeParse(dead).success, dead).toBe(false);
    }
  });

  it("canonicalProvider resolves a retired slug to its replacement (so it keeps verifying)", () => {
    // The load-bearing case: a secret registered under `customerio` before the slug was retired must
    // still select the Customer.io adapter. Returning null here is what would silently stop verifying.
    expect(canonicalProvider("customerio")).toBe("customer_io");
    for (const [dead, live] of Object.entries(RETIRED_PROVIDER_ALIASES)) {
      expect(canonicalProvider(dead), dead).toBe(live);
    }
  });

  it("canonicalProvider passes a live provider through unchanged", () => {
    expect(canonicalProvider("customer_io")).toBe("customer_io");
    expect(canonicalProvider("stripe")).toBe("stripe");
    for (const slug of PROVIDERS) expect(canonicalProvider(slug), slug).toBe(slug);
  });

  it("canonicalProvider normalises case and surrounding whitespace (the column is free text)", () => {
    expect(canonicalProvider("  CustomerIO ")).toBe("customer_io");
    expect(canonicalProvider("STRIPE")).toBe("stripe");
  });

  it("canonicalProvider returns null for anything unrecognised, including empty and null", () => {
    expect(canonicalProvider("not_a_provider")).toBeNull();
    expect(canonicalProvider("")).toBeNull();
    expect(canonicalProvider(null)).toBeNull();
    expect(canonicalProvider(undefined)).toBeNull();
  });
});
