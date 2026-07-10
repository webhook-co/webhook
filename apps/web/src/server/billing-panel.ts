import { SELF_SERVE_PLAN_IDS, type StripePlans, type BillingMode } from "@webhook-co/shared";

// What the dashboard's billing panel should render, as a pure function of config + customer state. Kept
// separate from the server actions so it is trivially testable and carries NO price figure: amounts live in
// Stripe, and its hosted Checkout is the only surface that shows them. This file must never learn a price.

export type BillingPanel =
  /** Billing is off, or no plan is configured for this deploy — render nothing at all. */
  | { readonly kind: "hidden" }
  /** No Stripe customer yet: offer the self-serve plans this deploy actually sells. */
  | { readonly kind: "picker"; readonly planIds: readonly string[] }
  /** A returning subscriber manages or cancels in Stripe's hosted Portal — we build no billing UI for it. */
  | { readonly kind: "portal" };

export function resolveBillingPanel(input: {
  readonly mode: BillingMode;
  readonly plans: StripePlans | null;
  readonly hasCustomer: boolean;
  /** Whether the configured Stripe secret key belongs to `mode` (see `stripeKeyMatchesMode`). */
  readonly keyMatchesMode: boolean;
}): BillingPanel {
  if (input.mode === "off" || !input.plans) return { kind: "hidden" };
  // A key that belongs to the OTHER mode means every Stripe call will be refused by makeStripeClient. Render
  // nothing rather than an "Upgrade" button that bounces the user back with an error. This is the transient
  // state while live secrets are swapped in before BILLING_MODE flips — offering a button that cannot work is
  // worse than offering none.
  if (!input.keyMatchesMode) return { kind: "hidden" };
  if (input.hasCustomer) return { kind: "portal" };
  // Ladder order (pro → scale), never the config object's key order: a JSON var is unordered, and the
  // picker must always read as a ladder of increasing volume.
  const planIds = SELF_SERVE_PLAN_IDS.filter((id) => input.plans?.[id] !== undefined);
  return planIds.length > 0 ? { kind: "picker", planIds } : { kind: "hidden" };
}
