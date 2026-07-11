import { describe, expect, it } from "vitest";

import {
  billingDisplayFromSubscription,
  billingEnabled,
  billingLive,
  parseBillingMode,
  isBillingActive,
  isLiveSubscriptionStatus,
  parseStripePlans,
  planIdForBasePrice,
  planSwitchItems,
  planLabel,
  SELF_SERVE_PLAN_IDS,
  SELF_SERVE_PLAN_LABELS,
  isSelfServePlan,
  stripeKeyMatchesMode,
  type BillingSubscriptionSummary,
} from "./billing";

describe("planIdForBasePrice + billingDisplayFromSubscription (current-plan card core)", () => {
  const PLANS = {
    pro: { base: "price_pro_base", overage: "price_pro_over" },
    scale: { base: "price_scale_base", overage: "price_scale_over" },
  };
  const sub = (over: Partial<BillingSubscriptionSummary> = {}): BillingSubscriptionSummary => ({
    plan: "price_pro_base",
    status: "active",
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...over,
  });

  it("reverse-looks-up the tier from the base price id", () => {
    expect(planIdForBasePrice(PLANS, "price_pro_base")).toBe("pro");
    expect(planIdForBasePrice(PLANS, "price_scale_base")).toBe("scale");
    expect(planIdForBasePrice(PLANS, "price_scale_over")).toBeNull(); // overage id is not a base
    expect(planIdForBasePrice(PLANS, "price_unknown")).toBeNull();
  });

  it("active subscription → active on its tier", () => {
    expect(billingDisplayFromSubscription(sub(), PLANS)).toEqual({
      tier: "pro",
      state: "active",
      periodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
  });

  it("cancel_at_period_end while still active → canceling (not yet canceled)", () => {
    expect(billingDisplayFromSubscription(sub({ cancelAtPeriodEnd: true }), PLANS).state).toBe(
      "canceling",
    );
  });

  it("status 'canceled' is terminal (overrides cancelAtPeriodEnd)", () => {
    expect(
      billingDisplayFromSubscription(sub({ status: "canceled", cancelAtPeriodEnd: true }), PLANS)
        .state,
    ).toBe("canceled");
  });

  it("past_due is a distinct grace state (entitled, NOT inactive) — ADR-0020", () => {
    expect(billingDisplayFromSubscription(sub({ status: "past_due" }), PLANS).state).toBe(
      "past_due",
    );
  });

  it("past_due OUTRANKS canceling — a failing card during the cancel grace must still surface", () => {
    // A customer who scheduled cancellation AND whose (final) charge is failing: the actionable
    // dunning message must win over 'canceling', or the failing payment is hidden. past_due is checked
    // before cancelAtPeriodEnd for exactly this.
    expect(
      billingDisplayFromSubscription(sub({ status: "past_due", cancelAtPeriodEnd: true }), PLANS)
        .state,
    ).toBe("past_due");
  });

  it("trialing → a distinct 'trialing' state (entitled, but no charge has happened yet)", () => {
    // trialing is entitled (in BILLING_ACTIVE_STATUSES) but rendering it as 'active'/"Renews" would
    // misstate money: the shown date is the trial's FIRST charge, not a renewal of an already-paid plan.
    expect(billingDisplayFromSubscription(sub({ status: "trialing" }), PLANS).state).toBe(
      "trialing",
    );
    // A trial scheduled to cancel still reads as canceling (it will simply end, un-charged).
    expect(
      billingDisplayFromSubscription(sub({ status: "trialing", cancelAtPeriodEnd: true }), PLANS)
        .state,
    ).toBe("canceling");
  });

  it("non-entitled statuses (unpaid/incomplete/paused) → inactive (back on Free)", () => {
    for (const status of ["unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(billingDisplayFromSubscription(sub({ status }), PLANS).state).toBe("inactive");
    }
  });

  it("an unknown base price (legacy/archived) still renders a state, tier 'unknown'", () => {
    const d = billingDisplayFromSubscription(sub({ plan: "price_legacy" }), PLANS);
    expect(d.tier).toBe("unknown");
    expect(d.state).toBe("active");
  });
});

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

describe("parseStripePlans — the self-serve plan → price-id map (fail-closed)", () => {
  const VALID =
    '{"pro":{"base":"price_pb","overage":"price_po"},"scale":{"base":"price_tb","overage":"price_to"}}';

  it("parses a well-formed map of every self-serve plan", () => {
    expect(parseStripePlans(VALID)).toEqual({
      pro: { base: "price_pb", overage: "price_po" },
      scale: { base: "price_tb", overage: "price_to" },
    });
  });

  it("accepts a subset — a deploy may sell only one plan", () => {
    expect(parseStripePlans('{"pro":{"base":"price_pb","overage":"price_po"}}')).toEqual({
      pro: { base: "price_pb", overage: "price_po" },
    });
  });

  it("carries price IDS ONLY — an amount/currency key is rejected, never persisted", () => {
    // Guardrail: no price/tier figure may enter this repo or its deploy vars. A config that smuggles an
    // amount is a misconfiguration, and we fail closed rather than let it flow into a line item.
    expect(
      parseStripePlans('{"pro":{"base":"price_pb","overage":"price_po","amount":2900}}'),
    ).toBeNull();
  });

  it("is fail-CLOSED on anything malformed (no Checkout beats a wrong Checkout)", () => {
    expect(parseStripePlans(undefined)).toBeNull();
    expect(parseStripePlans("")).toBeNull();
    expect(parseStripePlans("not json")).toBeNull();
    expect(parseStripePlans("[]")).toBeNull(); // array, not an object
    expect(parseStripePlans("{}")).toBeNull(); // no plans at all
    expect(parseStripePlans('{"pro":{"base":"price_pb"}}')).toBeNull(); // half-configured → no line item
    expect(parseStripePlans('{"pro":{"base":"","overage":"price_po"}}')).toBeNull(); // empty id
    expect(parseStripePlans('{"pro":{"base":1,"overage":"price_po"}}')).toBeNull(); // non-string id
  });

  it("rejects a plan id that is not self-serve (enterprise is contact-sales, never Checkout)", () => {
    expect(parseStripePlans('{"enterprise":{"base":"price_eb","overage":"price_eo"}}')).toBeNull();
    expect(parseStripePlans('{"free":{"base":"price_fb","overage":"price_fo"}}')).toBeNull();
  });

  it("rejects the whole config if ANY plan is bad — a partial map would silently hide a plan", () => {
    expect(
      parseStripePlans('{"pro":{"base":"price_pb","overage":"price_po"},"scale":{}}'),
    ).toBeNull();
  });
});

describe("planSwitchItems (WS4 plan switch — remap a live sub's items to the target plan)", () => {
  const PRO = { base: "price_pro_base", overage: "price_pro_over" };
  const SCALE = { base: "price_scale_base", overage: "price_scale_over" };

  it("remaps BOTH items (base + overage) to the target plan, preserving the item ids", () => {
    const items = [
      { id: "si_base", price: "price_pro_base" },
      { id: "si_over", price: "price_pro_over" },
    ];
    expect(planSwitchItems(items, PRO, SCALE)).toEqual([
      { id: "si_base", price: "price_scale_base" },
      { id: "si_over", price: "price_scale_over" },
    ]);
  });

  it("is order-independent — matches by price, not position (overage listed first)", () => {
    const items = [
      { id: "si_over", price: "price_pro_over" },
      { id: "si_base", price: "price_pro_base" },
    ];
    expect(planSwitchItems(items, PRO, SCALE)).toEqual([
      { id: "si_base", price: "price_scale_base" },
      { id: "si_over", price: "price_scale_over" },
    ]);
  });

  it("REFUSES (null) when the sub isn't cleanly on `current` — a legacy/hand-edited sub", () => {
    // Missing the overage price → we can't know which item is the meter → refuse rather than mis-bill.
    expect(planSwitchItems([{ id: "si_base", price: "price_pro_base" }], PRO, SCALE)).toBeNull();
    // A base price from neither plan → not on `current` at all.
    expect(
      planSwitchItems(
        [
          { id: "si_x", price: "price_legacy_base" },
          { id: "si_y", price: "price_legacy_over" },
        ],
        PRO,
        SCALE,
      ),
    ).toBeNull();
  });
});

describe("isLiveSubscriptionStatus — does a NEW Checkout risk a duplicate subscription?", () => {
  it("TERMINAL statuses are not live — resubscribing via Checkout is safe (no duplicate)", () => {
    // A canceled/incomplete_expired subscription no longer exists at Stripe, so a fresh Checkout is the
    // correct resubscribe path — it cannot create a second live subscription.
    expect(isLiveSubscriptionStatus("canceled")).toBe(false);
    expect(isLiveSubscriptionStatus("incomplete_expired")).toBe(false);
  });

  it("every non-terminal status IS live — a new Checkout would double-subscribe the customer", () => {
    // These subscriptions still EXIST at Stripe (even the non-entitled ones like unpaid/paused). Starting
    // a new Checkout on the same customer creates a SECOND concurrent subscription → double billing.
    for (const s of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]) {
      expect(isLiveSubscriptionStatus(s)).toBe(true);
    }
  });

  it("is fail-SAFE — an unknown status Stripe adds later counts as live (block the duplicate)", () => {
    expect(isLiveSubscriptionStatus("some_future_status")).toBe(true);
    expect(isLiveSubscriptionStatus("")).toBe(true);
  });
});

describe("plan labels (single source of truth, co-located with the plan ids)", () => {
  it("SELF_SERVE_PLAN_LABELS covers every self-serve plan id", () => {
    for (const id of SELF_SERVE_PLAN_IDS) {
      expect(SELF_SERVE_PLAN_LABELS[id]).toBeTruthy();
    }
    expect(SELF_SERVE_PLAN_LABELS).toEqual({ pro: "Pro", scale: "Scale" });
  });

  it("planLabel returns the display name for a known plan, a generic fallback otherwise", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("scale")).toBe("Scale");
    expect(planLabel("unknown")).toBe("Paid plan");
    expect(planLabel("enterprise")).toBe("Paid plan");
  });
});

describe("SELF_SERVE_PLAN_IDS", () => {
  it("is exactly the plans a user can buy without talking to us", () => {
    expect([...SELF_SERVE_PLAN_IDS]).toEqual(["pro", "scale"]);
  });

  it("isSelfServePlan gates Checkout — enterprise/free are not purchasable", () => {
    expect(isSelfServePlan("pro")).toBe(true);
    expect(isSelfServePlan("scale")).toBe(true);
    expect(isSelfServePlan("team")).toBe(false); // the old name must not linger as a live plan id
    expect(isSelfServePlan("enterprise")).toBe(false);
    expect(isSelfServePlan("free")).toBe(false);
    expect(isSelfServePlan("")).toBe(false);
  });
});

describe("stripeKeyMatchesMode — a live key must never run in test mode, and vice versa", () => {
  const LIVE = "sk_live_abc123";
  const TEST = "sk_test_abc123";

  it("accepts the key that belongs to the mode", () => {
    expect(stripeKeyMatchesMode("live", LIVE)).toBe(true);
    expect(stripeKeyMatchesMode("test", TEST)).toBe(true);
  });

  it("REJECTS a live key under BILLING_MODE=test — it would charge real cards from a test deploy", () => {
    expect(stripeKeyMatchesMode("test", LIVE)).toBe(false);
  });

  it("REJECTS a test key under BILLING_MODE=live — it would silently take no money", () => {
    expect(stripeKeyMatchesMode("live", TEST)).toBe(false);
  });

  it("rejects everything when billing is off (there is no legitimate key to use)", () => {
    expect(stripeKeyMatchesMode("off", LIVE)).toBe(false);
    expect(stripeKeyMatchesMode("off", TEST)).toBe(false);
  });

  it("rejects a key with neither prefix — restricted keys, publishable keys, garbage, empty", () => {
    // `pk_live_` is a PUBLISHABLE key: it must never be used as a secret. `rk_` is a restricted key,
    // whose scopes we don't control. Anything unrecognised fails closed.
    for (const bad of ["pk_live_x", "pk_test_x", "rk_live_x", "whsec_x", "sk_", "", "SK_LIVE_X"]) {
      expect(stripeKeyMatchesMode("live", bad)).toBe(false);
      expect(stripeKeyMatchesMode("test", bad)).toBe(false);
    }
  });
});
