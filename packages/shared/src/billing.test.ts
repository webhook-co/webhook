import { describe, expect, it } from "vitest";

import { billingEnabled, billingLive, parseBillingMode } from "./billing";

describe("parseBillingMode (fail-safe billing flag)", () => {
  it("accepts the three known modes (case-insensitive, trimmed)", () => {
    expect(parseBillingMode("off")).toBe("off");
    expect(parseBillingMode("test")).toBe("test");
    expect(parseBillingMode("live")).toBe("live");
    expect(parseBillingMode("  TEST  ")).toBe("test");
    expect(parseBillingMode("Live")).toBe("live");
  });

  it("fails safe to 'off' for unset / blank / unknown values — never accidentally enables Stripe", () => {
    expect(parseBillingMode(undefined)).toBe("off");
    expect(parseBillingMode(null)).toBe("off");
    expect(parseBillingMode("")).toBe("off");
    expect(parseBillingMode("   ")).toBe("off");
    expect(parseBillingMode("production")).toBe("off");
    expect(parseBillingMode("1")).toBe("off");
    expect(parseBillingMode("livee")).toBe("off");
  });

  it("billingEnabled is true only for test/live, false for off", () => {
    expect(billingEnabled("off")).toBe(false);
    expect(billingEnabled("test")).toBe(true);
    expect(billingEnabled("live")).toBe(true);
  });

  it("billingLive is true ONLY for live (the real-charge gate)", () => {
    expect(billingLive("off")).toBe(false);
    expect(billingLive("test")).toBe(false);
    expect(billingLive("live")).toBe(true);
  });
});
