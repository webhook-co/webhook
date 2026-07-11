import { describe, expect, it } from "vitest";

import { baseFeeRefundMinorUnits } from "./refund";

// The usage-based base-fee refund (data-lifecycle slice 2.4). The Terms promise a refund of the prepaid base
// fee "in proportion to how little of your plan's included volume you consumed" — NOT by calendar days. So:
//   refund = base × (1 − consumed / included)
// Everything here is pure integer-minor-units arithmetic; the money guard is that it can NEVER return more
// than the base actually charged, and never a negative. Both directions are real money bugs.

describe("baseFeeRefundMinorUnits", () => {
  it("refunds the whole base when the customer consumed nothing", () => {
    expect(baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 0, included: 500_000 })).toBe(
      1900,
    );
  });

  it("refunds nothing when the customer consumed their entire included volume", () => {
    expect(
      baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 500_000, included: 500_000 }),
    ).toBe(0);
  });

  it("refunds the unused proportion (half consumed → half back)", () => {
    expect(
      baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 250_000, included: 500_000 }),
    ).toBe(950);
  });

  it("rounds to the nearest minor unit", () => {
    // 1 − 1/3 = 0.666… → 1900 × 0.6667 = 1266.67 → 1267 cents.
    expect(
      baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 100_000, included: 300_000 }),
    ).toBe(1267);
  });

  it("CLAMPS to zero when the customer OVERSHOT their included volume (never a negative refund)", () => {
    // Overage is billed in arrears, so overshooting means they owe us more — it must never invert into a
    // negative refund (which Stripe would reject, or worse, a caller could mis-sign into a charge).
    expect(
      baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 900_000, included: 500_000 }),
    ).toBe(0);
  });

  it("NEVER refunds more than the base that was actually charged", () => {
    // A nonsense negative `consumed` must not inflate the ratio above 1.
    expect(
      baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: -5000, included: 500_000 }),
    ).toBe(1900);
  });

  it("refunds nothing on an UNLIMITED plan (no included volume → the proportion is undefined)", () => {
    // `included: null` is the uncapped mirror value. There is no denominator, so there is no usage-based
    // proportion to refund. Fail-closed to 0 rather than inventing a time-based refund the Terms don't promise.
    expect(baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 10, included: null })).toBe(0);
  });

  it("refunds nothing when the included volume is zero (a degenerate cap → no division by zero)", () => {
    expect(baseFeeRefundMinorUnits({ baseMinorUnits: 1900, consumed: 0, included: 0 })).toBe(0);
  });

  it("refunds nothing when no base fee was actually charged (e.g. a trial that never billed)", () => {
    expect(baseFeeRefundMinorUnits({ baseMinorUnits: 0, consumed: 0, included: 500_000 })).toBe(0);
  });

  it("refunds nothing for a negative/garbage base (fail-closed, never mints money)", () => {
    expect(baseFeeRefundMinorUnits({ baseMinorUnits: -1900, consumed: 0, included: 500_000 })).toBe(
      0,
    );
  });

  it("is exact at 1 event consumed out of a large cap (no float drift into an over-refund)", () => {
    const refund = baseFeeRefundMinorUnits({
      baseMinorUnits: 9900,
      consumed: 1,
      included: 3_000_000,
    });
    expect(refund).toBeLessThanOrEqual(9900);
    expect(refund).toBe(9900); // 9900 × (1 − 1/3e6) = 9899.9967 → 9900
  });
});
