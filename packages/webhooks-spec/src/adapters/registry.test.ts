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
});
