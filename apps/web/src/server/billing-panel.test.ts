import { describe, expect, it } from "vitest";

import { resolveBillingPanel } from "./billing-panel";

// The dashboard billing panel is a pure function of (billing mode, configured plans, existing customer).
// It must NEVER carry a price figure — Stripe's hosted Checkout is the only place an amount is shown.

describe("resolveBillingPanel", () => {
  const PLANS = { pro: { base: "p1", overage: "p2" }, scale: { base: "s1", overage: "s2" } };

  it("hides the whole panel when billing is off (no Checkout, no Portal)", () => {
    expect(
      resolveBillingPanel({ mode: "off", plans: PLANS, hasCustomer: false, keyMatchesMode: true }),
    ).toEqual({
      kind: "hidden",
    });
  });

  it("hides the panel when billing is on but no plans are configured (fail-closed)", () => {
    // parseStripePlans already fail-closes to null; the panel must not render an empty picker.
    expect(
      resolveBillingPanel({ mode: "test", plans: null, hasCustomer: false, keyMatchesMode: true }),
    ).toEqual({
      kind: "hidden",
    });
  });

  it("offers the configured self-serve plans, in ladder order, to an org with no subscription", () => {
    const panel = resolveBillingPanel({
      mode: "test",
      plans: PLANS,
      hasCustomer: false,
      keyMatchesMode: true,
    });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro", "scale"] });
  });

  it("offers only the plans THIS deploy configured (a partial map is not a broken page)", () => {
    const panel = resolveBillingPanel({
      mode: "live",
      plans: { pro: { base: "p1", overage: "p2" } },
      hasCustomer: false,
      keyMatchesMode: true,
    });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro"] });
  });

  it("shows the Portal to an org that already has a Stripe customer", () => {
    // A returning subscriber manages/cancels in Stripe's Portal — we never build a billing UI for that.
    expect(
      resolveBillingPanel({ mode: "test", plans: PLANS, hasCustomer: true, keyMatchesMode: true }),
    ).toEqual({
      kind: "portal",
    });
  });

  it("orders the picker by the ladder, never by object key insertion", () => {
    const panel = resolveBillingPanel({
      mode: "test",
      plans: { scale: { base: "s1", overage: "s2" }, pro: { base: "p1", overage: "p2" } },
      hasCustomer: false,
      keyMatchesMode: true,
    });
    expect(panel).toEqual({ kind: "picker", planIds: ["pro", "scale"] }); // pro before scale
  });
});

describe("resolveBillingPanel — a key that doesn't match the mode hides the panel entirely", () => {
  const PLANS = { pro: { base: "p1", overage: "p2" }, scale: { base: "s1", overage: "s2" } };

  it("hides the picker when the Stripe key belongs to the other mode", () => {
    // Otherwise the dashboard advertises "Upgrade to Pro", the user clicks, the constructor guard throws,
    // and they get an error banner. Nothing charges — but offering a button that cannot work is worse than
    // offering none. This is the state during a live-secret swap, before BILLING_MODE flips.
    expect(
      resolveBillingPanel({
        mode: "test",
        plans: PLANS,
        hasCustomer: false,
        keyMatchesMode: false,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("hides the PORTAL too — managing a subscription needs the same client", () => {
    expect(
      resolveBillingPanel({ mode: "test", plans: PLANS, hasCustomer: true, keyMatchesMode: false }),
    ).toEqual({ kind: "hidden" });
  });

  it("shows the picker once the key and mode agree", () => {
    expect(
      resolveBillingPanel({ mode: "live", plans: PLANS, hasCustomer: false, keyMatchesMode: true }),
    ).toEqual({ kind: "picker", planIds: ["pro", "scale"] });
  });
});
