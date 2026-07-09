import { describe, expect, it } from "vitest";

import { resolveBillingPanel } from "./billing-panel";

// The dashboard billing panel is a pure function of (billing mode, configured plans, existing customer).
// It must NEVER carry a price figure — Stripe's hosted Checkout is the only place an amount is shown.

describe("resolveBillingPanel", () => {
  const PLANS = { pro: { base: "p1", overage: "p2" }, scale: { base: "s1", overage: "s2" } };

  it("hides the whole panel when billing is off (no Checkout, no Portal)", () => {
    expect(resolveBillingPanel({ mode: "off", plans: PLANS, hasCustomer: false })).toEqual({
      kind: "hidden",
    });
  });

  it("hides the panel when billing is on but no plans are configured (fail-closed)", () => {
    // parseStripePlans already fail-closes to null; the panel must not render an empty picker.
    expect(resolveBillingPanel({ mode: "test", plans: null, hasCustomer: false })).toEqual({
      kind: "hidden",
    });
  });

  it("offers the configured self-serve plans, in ladder order, to an org with no subscription", () => {
    const panel = resolveBillingPanel({ mode: "test", plans: PLANS, hasCustomer: false });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro", "scale"] });
  });

  it("offers only the plans THIS deploy configured (a partial map is not a broken page)", () => {
    const panel = resolveBillingPanel({
      mode: "live",
      plans: { pro: { base: "p1", overage: "p2" } },
      hasCustomer: false,
    });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro"] });
  });

  it("shows the Portal to an org that already has a Stripe customer", () => {
    // A returning subscriber manages/cancels in Stripe's Portal — we never build a billing UI for that.
    expect(resolveBillingPanel({ mode: "test", plans: PLANS, hasCustomer: true })).toEqual({
      kind: "portal",
    });
  });

  it("orders the picker by the ladder, never by object key insertion", () => {
    const panel = resolveBillingPanel({
      mode: "test",
      plans: { scale: { base: "s1", overage: "s2" }, pro: { base: "p1", overage: "p2" } },
      hasCustomer: false,
    });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro", "scale"] }); // pro before scale
  });
});
