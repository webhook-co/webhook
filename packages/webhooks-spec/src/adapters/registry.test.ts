import { describe, expect, it } from "vitest";

import { WEBHOOK_SCHEMES } from "../scheme";
import { detectScheme, getAdapterForScheme, ADAPTER_SCHEMES } from "./registry";

describe("getAdapterForScheme", () => {
  it("returns an adapter for every non-unknown scheme", () => {
    for (const scheme of WEBHOOK_SCHEMES) {
      if (scheme === "unknown") continue;
      const adapter = getAdapterForScheme(scheme);
      expect(adapter).toBeDefined();
      expect(adapter?.scheme).toBe(scheme);
    }
  });

  it("excludes `unknown` from the registry", () => {
    expect(getAdapterForScheme("unknown")).toBeUndefined();
    expect(ADAPTER_SCHEMES).not.toContain("unknown");
  });

  it("each registered adapter carries a tolerance and a signature header", () => {
    for (const scheme of ADAPTER_SCHEMES) {
      const adapter = getAdapterForScheme(scheme)!;
      expect(adapter.signatureHeader).toBe(adapter.signatureHeader.toLowerCase());
      expect(adapter.toleranceSeconds).toBeGreaterThan(0);
    }
  });
});

describe("detectScheme", () => {
  function h(...pairs: Array<[string, string]>): ReadonlyArray<readonly [string, string]> {
    return pairs;
  }

  it("detects Stripe from its signature header (case-insensitive)", () => {
    expect(detectScheme(h(["Stripe-Signature", "t=1,v1=x"]))).toBe("stripe");
  });

  it("detects GitHub from X-Hub-Signature-256", () => {
    expect(detectScheme(h(["x-hub-signature-256", "sha256=x"]))).toBe("github");
  });

  it("detects Shopify, Slack, and Standard Webhooks from their headers", () => {
    expect(detectScheme(h(["X-Shopify-Hmac-Sha256", "abc"]))).toBe("shopify");
    expect(detectScheme(h(["X-Slack-Signature", "v0=x"]))).toBe("slack");
    expect(detectScheme(h(["webhook-signature", "v1,x"]))).toBe("standard_webhooks");
  });

  it("returns `unknown` when no known signature header is present", () => {
    expect(detectScheme(h(["content-type", "application/json"]))).toBe("unknown");
  });

  it("returns `unknown` for an empty header set", () => {
    expect(detectScheme(h())).toBe("unknown");
  });

  /**
   * Signature header names are NOT unique across providers, and `detectScheme` returns the FIRST
   * registry match. That makes `PROVIDERS` order load-bearing for a shared header, and nothing used
   * to pin it — so the README could describe detection as identification and no test disagreed.
   *
   * The README now says `x-signature` alone resolves to `modern_treasury` even though five other
   * providers send it with different schemes. This pins BOTH halves of that sentence: the winner,
   * and the set it wins over. Add a seventh `x-signature` provider, or reorder the registry, and this
   * fails asking you to re-check the README — which is the intended cost, because the difference is
   * a confident wrong answer (Segment is SHA-1; Mercado Pago signs a URL manifest), not a miss.
   *
   * Derived through `getAdapterForScheme`, NOT `PROVIDER_CONFIGS`, because that is the map
   * `detectScheme` actually reads: `REGISTRY` prefers a bespoke adapter over a config row for the
   * same slug, and 32 of the 144 slugs have no config row at all. Filtering the config map would be
   * blind to every one of them — a bespoke-only provider adopting `x-signature` would leave this
   * green while the README's list of five went stale, and `config.ts` explicitly tells contributors
   * to APPEND new providers, which is exactly the shape that would slip through. It is also the same
   * trap `published-counts.test.ts` documents for Twilio, whose config row never runs.
   */
  it("resolves a shared header to the first registry match, and the README names the right set", () => {
    const sharers = ADAPTER_SCHEMES.filter(
      (s) => getAdapterForScheme(s)?.signatureHeader === "x-signature",
    );

    // Not a floor — `toEqual` below already fails on an empty set. It is a better error message for
    // the "the header was renamed and nothing declares it any more" case, which otherwise reports as
    // a confusing six-element diff against [].
    expect(sharers.length, "no adapter declares x-signature — re-point this test").toBeGreaterThan(
      1,
    );

    expect(sharers).toEqual([
      "modern_treasury",
      "segment",
      "airwallex",
      "lemon_squeezy",
      "clickup",
      "mercado_pago",
    ]);
    expect(detectScheme(h(["x-signature", "abc"]))).toBe(sharers[0]);
  });
});
