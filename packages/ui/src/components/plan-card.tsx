import * as React from "react";

import { cn } from "../lib/cn";

/** The plan facts a PlanCard lays out — structurally the `Plan` from `@webhook-co/shared/plans`, kept as a
 *  local shape so `@webhook-co/ui` needs no dependency on the shared catalog. */
export interface PlanCardPlan {
  readonly name: string;
  readonly pricePrefix?: string;
  readonly price: string | null;
  readonly cadence: string | null;
  readonly includedEvents: string;
  readonly summary: string;
  readonly retention: string;
  readonly overage: string;
  readonly featured?: boolean;
}

export interface PlanCardProps {
  readonly plan: PlanCardPlan;
  /** Highlight the card's border. Defaults to `plan.featured` (the marketing "most teams" tier). The
   *  dashboard passes `true` for the org's CURRENT plan. */
  readonly highlighted?: boolean;
  /** A badge beside the name. Defaults to "Most teams" for a featured plan; the dashboard overrides it with
   *  "Current plan". Pass `null` to suppress. */
  readonly badge?: React.ReactNode;
  /** The bottom action: an `<a>` on the pricing grid, a Checkout/Switch `<form>` on the dashboard, or a
   *  plain note (e.g. "Your current plan"). Sits at the card foot via `mt-auto`. */
  readonly cta?: React.ReactNode;
  readonly className?: string;
}

/**
 * One shared plan card for the marketing pricing grid AND the dashboard billing cards. It renders the plan
 * facts (name, price, included volume, overage, retention) identically on both surfaces — "the same cards as
 * pricing" — and takes the differing bits as slots: the CTA (`<a>` vs a Checkout/Switch `<form>`) and the
 * badge ("Most teams" vs "Current plan"). The plan DATA comes from the one catalog (`@webhook-co/shared/plans`),
 * so the two surfaces can never quote different numbers.
 */
export function PlanCard({ plan, highlighted, badge, cta, className }: PlanCardProps) {
  const isHighlighted = highlighted ?? plan.featured ?? false;
  // `badge` prop wins (including an explicit `null` to suppress); otherwise default to the featured badge.
  const shownBadge =
    badge !== undefined ? (
      badge
    ) : plan.featured ? (
      <span className="rounded-full border border-hairline px-2 py-0.5 text-xs text-fg-secondary">
        Most teams
      </span>
    ) : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-5 rounded-card border bg-surface p-6",
        isHighlighted ? "border-fg" : "border-hairline",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-heading text-fg">{plan.name}</h2>
          {shownBadge}
        </div>
        <p className="text-sm leading-snug text-fg-secondary">{plan.summary}</p>
      </div>

      {/* Baseline-aligned and nowrap: "From €499 /month" must never break across lines, and a long
          qualifier must not push the cadence onto its own row. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        {plan.pricePrefix && <span className="text-sm text-fg-secondary">{plan.pricePrefix}</span>}
        <span className="text-3xl font-semibold tracking-heading text-fg">
          {plan.price ?? "Free"}
        </span>
        {plan.cadence && <span className="text-sm text-fg-secondary">{plan.cadence}</span>}
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-col">
          <dt className="sr-only">Included events</dt>
          <dd className="text-fg">{plan.includedEvents}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="sr-only">Overage</dt>
          <dd className="text-fg-secondary">{plan.overage}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="sr-only">Retention</dt>
          <dd className="text-fg-secondary">{plan.retention}</dd>
        </div>
      </dl>

      {cta !== undefined && <div className="mt-auto">{cta}</div>}
    </div>
  );
}
