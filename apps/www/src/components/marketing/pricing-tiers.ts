// The sanctioned pricing ladder (ADR-0004, internal research/unit-economics-2026-07-09.md).
//
// These figures are PUBLIC and are what Stripe actually charges — the live prices carry the same amounts and
// the same included volumes (`metadata.event_cap`). If you change a number here, change it in Stripe too, or
// the page lies. `apps/web` deliberately holds NO figures: the dashboard reads the org's cap from the DB and
// Stripe's hosted Checkout shows the price. This file is the one public place a number lives.
//
// Price per event FALLS as you climb (26k → 30k → 40k events per dollar). That is the whole shape of the
// ladder: upgrading must buy cheaper events, never dearer ones.

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

export const OVERAGE_PER_MILLION = "$25";

export const TIERS: readonly Tier[] = [
  {
    id: "free",
    name: "Free",
    price: null,
    cadence: null,
    includedEvents: "5,000 events, once",
    summary: "A real trial, not a perpetual tier. The 5,000 events never reset.",
    retention: "7-day retention",
    overage: "No overage. Capture pauses at the limit.",
    cta: { label: "Start free", href: "https://app.webhook.co" },
  },
  {
    id: "pro",
    name: "Pro",
    price: "$19",
    cadence: "/month",
    includedEvents: "500,000 events / month",
    summary: "For a service in production with real traffic.",
    retention: "30-day retention",
    overage: `${OVERAGE_PER_MILLION} per additional million events`,
    cta: { label: "Start on Pro", href: "https://app.webhook.co/usage" },
    featured: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: "$99",
    cadence: "/month",
    includedEvents: "3,000,000 events / month",
    summary: "For high-volume ingestion and fan-out to many destinations.",
    retention: "90-day retention",
    overage: `${OVERAGE_PER_MILLION} per additional million events`,
    cta: { label: "Start on Scale", href: "https://app.webhook.co/usage" },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    pricePrefix: "From",
    price: "$499",
    cadence: "/month",
    includedEvents: "20,000,000+ events / month",
    summary: "Committed volume, SAML SSO, audit export, and a BAA.",
    retention: "Retention up to 1 year",
    overage: "Custom, agreed up front.",
    cta: { label: "Talk to us", href: "mailto:sales@webhook.co" },
  },
];
