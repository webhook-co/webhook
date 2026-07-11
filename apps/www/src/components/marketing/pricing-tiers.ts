// The sanctioned pricing ladder (ADR-0004, internal research/unit-economics-2026-07-09.md).
//
// These figures are PUBLIC and are what Stripe actually charges — the live prices carry the same amounts and
// the same included volumes (`metadata.event_cap`). If you change a number here, change it in Stripe too, or
// the page lies. `apps/web` deliberately holds NO figures: the dashboard reads the org's cap from the DB and
// Stripe's hosted Checkout shows the price. This file is the one public place a number lives.
//
// Price per event FALLS as you climb (26k → 30k → 40k events per euro). That is the whole shape of the
// ladder: upgrading must buy cheaper events, never dearer ones.
//
// The `retention` strings below must stay in step with what the engine actually ENFORCES —
// packages/shared/src/retention.ts (PLAN_RETENTION_DAYS): Free 7d / Pro 30d / Scale 90d. Enterprise is
// unlimited/contractual there (never auto-pruned); publicly we state "up to 1 year". Change one, change both.

import { LINKS, SALES } from "@/lib/links";

export interface Tier {
  readonly id: string;
  readonly name: string;
  /** A small qualifier rendered BEFORE the amount ("From"), so it never wraps away from it. */
  readonly pricePrefix?: string;
  /** Display price. `null` = free. */
  readonly price: string | null;
  readonly cadence: string | null;
  readonly includedEvents: string;
  /** The one line that says who this is for. No hedging. */
  readonly summary: string;
  readonly retention: string;
  /** Overage, or the reason there isn't one. */
  readonly overage: string;
  readonly cta: { readonly label: string; readonly href: string };
  readonly featured?: boolean;
}

export const OVERAGE_PER_MILLION = "€25";

export const TIERS: readonly Tier[] = [
  {
    id: "free",
    name: "Free",
    price: null,
    cadence: null,
    includedEvents: "5,000 events, once",
    summary: "A real trial, not a perpetual tier. The 5,000 events never reset.",
    retention: "7-day retention",
    // Kept short so it sets on one line in the tier card. "At the limit" is already carried by
    // `includedEvents` directly above it, and the pause is stated in full three more times on the
    // page — so the MUST-disclose fact (ADR-0004) survives the shorter line intact.
    overage: "No overage. Capture pauses.",
    cta: { label: "Start free", href: LINKS.startFree },
  },
  {
    id: "pro",
    name: "Pro",
    price: "€19",
    cadence: "/month",
    includedEvents: "500,000 events / month",
    summary: "For a service in production with real traffic.",
    retention: "30-day retention",
    overage: `${OVERAGE_PER_MILLION} per extra million events`,
    cta: { label: "Start on Pro", href: LINKS.usage },
    featured: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: "€99",
    cadence: "/month",
    includedEvents: "3,000,000 events / month",
    summary: "For high-volume ingestion and fan-out to many destinations.",
    retention: "90-day retention",
    overage: `${OVERAGE_PER_MILLION} per extra million events`,
    cta: { label: "Start on Scale", href: LINKS.usage },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    pricePrefix: "From",
    price: "€499",
    cadence: "/month",
    includedEvents: "20,000,000+ events / month",
    summary: "Committed volume, SAML SSO, audit export, and a BAA.",
    retention: "Retention up to 1 year",
    overage: "Custom, agreed up front.",
    cta: { label: "Talk to us", href: SALES },
  },
];
