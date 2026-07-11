// The usage-based base-fee refund (data-lifecycle slice 2.4) — the arithmetic behind the promise the Terms
// make: on cancellation we refund the prepaid base fee "in proportion to how little of your plan's included
// volume you consumed", rather than by counting calendar days. Overage is billed in ARREARS, so there is
// never anything unused to refund there; the base fee is the only prepaid money in the system.
//
//   refund = base × (1 − consumed / included)
//
// Pure, integer minor units (cents), and deliberately paranoid: this function's output is handed straight to
// Stripe as an amount to move, so both failure directions are real money bugs — refunding MORE than we
// charged mints money, and a negative amount is a charge wearing a refund's clothes. Every degenerate input
// (no cap, zero cap, overshoot, garbage) fails CLOSED to 0 rather than guessing.
//
// No price/amount figure lives in this repo (parseStripePlans actively rejects an `amount` key). `base` is
// therefore always read from Stripe at runtime — the base line of the invoice that actually took the money.

export interface BaseFeeRefundArgs {
  /** The base fee ACTUALLY charged for the current period, in minor units, read from the paid Stripe invoice.
   *  0 when nothing was ever charged (a trial that never billed) → nothing to refund. */
  readonly baseMinorUnits: number;
  /** Billable events consumed in the current period (sumPeriodEventUsage — the same basis the soft cap uses). */
  readonly consumed: number;
  /** The plan's INCLUDED event volume (the mirrored cap). `null` = uncapped/unlimited: no denominator, so no
   *  usage proportion exists and we refund nothing rather than invent a time-based rule the Terms don't promise. */
  readonly included: number | null;
}

/**
 * The base-fee refund in minor units: the unused proportion of the plan's included volume, clamped to
 * `[0, baseMinorUnits]`. Rounded to the nearest minor unit. Returns 0 for every case where the proportion is
 * undefined or would exceed what we took (unlimited plan, zero cap, overshot cap, non-positive base).
 */
export function baseFeeRefundMinorUnits({
  baseMinorUnits,
  consumed,
  included,
}: BaseFeeRefundArgs): number {
  // Nothing was prepaid (or a garbage/negative base): there is no money to give back. Fail closed.
  if (!Number.isFinite(baseMinorUnits) || baseMinorUnits <= 0) return 0;
  // No denominator → no usage proportion. Uncapped plans and a degenerate zero cap both land here.
  if (included == null || !Number.isFinite(included) || included <= 0) return 0;
  // A garbage/negative `consumed` must not inflate the unused ratio above 1 and over-refund.
  const used = Number.isFinite(consumed) && consumed > 0 ? consumed : 0;
  // Overshot the included volume → they owe us overage, not the other way round.
  if (used >= included) return 0;

  const unusedRatio = 1 - used / included;
  const refund = Math.round(baseMinorUnits * unusedRatio);
  // Belt-and-braces against float drift at the extremes: the refund can never exceed what was charged.
  return Math.min(Math.max(refund, 0), baseMinorUnits);
}
