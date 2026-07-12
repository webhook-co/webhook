// The pricing ladder RENDERED on the marketing page. The figures no longer live here — they come from the
// one canonical catalog, `@webhook-co/shared/plans` (the same source the dashboard billing cards and the
// engine's retention/metering read), so a price can never disagree across surfaces. This file only adds the
// marketing-specific CTA (where each tier's button lands) on top of the shared plan data.

import { OVERAGE_PER_MILLION, PLANS, type Plan } from "@webhook-co/shared/plans";

import { LINKS, SALES } from "@/lib/links";

export { OVERAGE_PER_MILLION };

/** A marketing tier: the shared plan facts + the page's own CTA. */
export type Tier = Plan & { readonly cta: { readonly label: string; readonly href: string } };

/** Per-tier CTA. Free/paid land on the app (usage is where a plan is chosen); Enterprise is sales-led. */
const CTA_BY_ID: Record<Plan["id"], { label: string; href: string }> = {
  free: { label: "Start free", href: LINKS.startFree },
  pro: { label: "Start on Pro", href: LINKS.usage },
  scale: { label: "Start on Scale", href: LINKS.usage },
  enterprise: { label: "Talk to us", href: SALES },
};

export const TIERS: readonly Tier[] = PLANS.map((plan) => ({ ...plan, cta: CTA_BY_ID[plan.id] }));
