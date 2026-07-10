import { describe, expect, it } from "vitest";

import {
  billingEnabled,
  billingLive,
  parseBillingMode,
  isBillingActive,
  parseStripePlans,
  SELF_SERVE_PLAN_IDS,
  isSelfServePlan,
  stripeKeyMatchesMode,
} from "./billing";

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
