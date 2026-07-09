import { describe, expect, it } from "vitest";

import { billingEnabled, billingLive, parseBillingMode, isBillingActive } from "./billing";

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

describe("isBillingActive — which Stripe statuses ENTITLE an org to its paid plan", () => {
  it("entitles active + trialing (paid, in good standing)", () => {
    expect(isBillingActive("active")).toBe(true);
    expect(isBillingActive("trialing")).toBe(true);
  });

  it("entitles past_due — dunning is a GRACE window, never an instant pause (ADR-0020)", () => {
    expect(isBillingActive("past_due")).toBe(true);
  });

  it("does NOT entitle a subscription that never completed its first payment", () => {
    // `incomplete` → the initial invoice is unpaid; `incomplete_expired` → it never got paid.
    // Treating these as paid would hand a free monthly-resetting paid cap to anyone who opens Checkout.
    expect(isBillingActive("incomplete")).toBe(false);
    expect(isBillingActive("incomplete_expired")).toBe(false);
  });

  it("does NOT entitle terminal / suspended states", () => {
    expect(isBillingActive("unpaid")).toBe(false); // Stripe's END of dunning — retries exhausted
    expect(isBillingActive("paused")).toBe(false);
    expect(isBillingActive("canceled")).toBe(false);
  });

  it("is an ALLOWLIST — an unknown status Stripe adds later is not entitled (fail-closed)", () => {
    expect(isBillingActive("some_future_status")).toBe(false);
    expect(isBillingActive("")).toBe(false);
    expect(isBillingActive("ACTIVE")).toBe(false); // exact match only, no case coercion
  });
});
