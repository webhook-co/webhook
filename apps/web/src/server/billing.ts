import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readBillingCustomerId, readBillingSummary } from "@webhook-co/db/reads";
import {
  billingDisplayFromSubscription,
  billingEnabled,
  isSelfServePlan,
  makeStripeClient,
  SELF_SERVE_PLAN_IDS,
  stripeKeyMatchesMode,
  type BillingDisplay,
  type SelfServePlanId,
  type StripeClient,
} from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getBillingMode, getStripePlans, getStripeSecretKey } from "./env";

// The dashboard billing actions (S4.4b) — hosted Stripe Checkout (upgrade) + Customer Portal (manage).
// Everything is gated on BILLING_MODE: unless it is test/live AND the Stripe key + price ids are configured,
// these no-op ("disabled") so the dashboard shows no billing UI and no Stripe call is ever made. Never
// throws — a Stripe/db fault becomes an "error" state the page renders as a banner, not a 500.

/** Where Checkout success/cancel + the Portal return land (the dedicated Billing section). */
const BILLING_RETURN_URL = "https://app.webhook.co/billing";

export type BillingActionResult =
  | { readonly status: "ok"; readonly url: string }
  /** BILLING_MODE off, or the Stripe key / plan price ids aren't configured — no billing UI. */
  | { readonly status: "disabled" }
  /** The requested plan isn't one this deploy sells (unknown id, or a contact-sales plan like enterprise). */
  | { readonly status: "unknown_plan" }
  /** Portal only: the org has never subscribed, so there's no Stripe customer to manage. */
  | { readonly status: "no_customer" }
  | { readonly status: "error" };

/** Build the Stripe client from env, or null when billing isn't fully configured (key missing). */
async function stripeClientFromEnv(): Promise<StripeClient | null> {
  const mode = getBillingMode();
  const secretKey = await getStripeSecretKey();
  if (!secretKey) return null;
  // The key must belong to the mode. A live key under BILLING_MODE=test would charge REAL CARDS from a
  // deploy nobody thinks is live; a test key under live would sell plans and take no money. Both are silent,
  // so refuse to build a client at all — Checkout renders as "disabled" rather than doing the wrong thing.
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    logActionError(
      "billing.key_mode_mismatch",
      new Error("Stripe key does not match BILLING_MODE"),
    );
    return null;
  }
  return makeStripeClient({ mode, secretKey });
}

/**
 * Start a hosted Checkout to subscribe/upgrade. Reuses the org's existing Stripe customer if it has one
 * (a returning subscriber); otherwise Checkout creates the customer (email prefilled) and the inbound
 * webhook records it. The org id rides client_reference_id + subscription metadata (a signed value we
 * control) so the webhook can attribute the subscription without trusting email.
 */
export async function startCheckout(
  orgId: string,
  planId: string,
  email?: string,
): Promise<BillingActionResult> {
  if (!billingEnabled(getBillingMode())) return { status: "disabled" };
  const plans = getStripePlans();
  if (!plans) return { status: "disabled" };
  // Gate the plan id BEFORE any Stripe call. `planId` arrives from a form post, so it is untrusted input:
  // it must name a self-serve plan (never enterprise/free) that THIS deploy actually configured prices for.
  if (!isSelfServePlan(planId)) return { status: "unknown_plan" };
  const prices = plans[planId];
  if (!prices) return { status: "unknown_plan" };
  try {
    // Resolve the secret (a Secrets Store .get() is network-backed) INSIDE the try so a transient fault
    // becomes an "error" banner, never an unhandled server-action rejection. A null key = not configured.
    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };
    const existingCustomer = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readBillingCustomerId(tx)),
    );
    const session = await client.createCheckoutSession({
      customer: existingCustomer ?? undefined,
      customerEmail: existingCustomer ? undefined : email,
      lineItems: [{ price: prices.base, quantity: 1 }, { price: prices.overage }],
      successUrl: `${BILLING_RETURN_URL}?checkout=success`,
      cancelUrl: `${BILLING_RETURN_URL}?checkout=cancelled`,
      orgId,
    });
    return { status: "ok", url: session.url };
  } catch (error) {
    logActionError("billing.checkout_failed", error);
    return { status: "error" };
  }
}

/** Open the hosted Customer Portal to manage/cancel the subscription. Requires an existing customer. */
export async function openBillingPortal(orgId: string): Promise<BillingActionResult> {
  if (!billingEnabled(getBillingMode())) return { status: "disabled" };
  try {
    // Secret resolution is inside the try (see startCheckout) — a Secrets Store fault → "error", not a 500.
    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };
    const customer = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readBillingCustomerId(tx)),
    );
    if (!customer) return { status: "no_customer" };
    const session = await client.createPortalSession({ customer, returnUrl: BILLING_RETURN_URL });
    return { status: "ok", url: session.url };
  } catch (error) {
    logActionError("billing.portal_failed", error);
    return { status: "error" };
  }
}

/** Everything the dedicated Billing section renders for `orgId`. `display` is the current subscription's
 *  derived state (or null if never subscribed); `upgradePlanIds` is the self-serve ladder to offer when the
 *  org is NOT on an entitled paid plan (unsubscribed, canceled, or lapsed); `hasCustomer` gates the hosted
 *  Portal (cancel / payment method / invoices). Never throws — a fault hides the section, page still renders. */
export interface BillingView {
  readonly hidden: boolean;
  readonly display: BillingDisplay | null;
  readonly upgradePlanIds: readonly SelfServePlanId[];
  readonly hasCustomer: boolean;
}

const HIDDEN_VIEW: BillingView = {
  hidden: true,
  display: null,
  upgradePlanIds: [],
  hasCustomer: false,
};

/** Whether a display state still entitles the org to its paid plan (so we don't offer an upgrade picker). */
function isEntitledState(state: BillingDisplay["state"] | undefined): boolean {
  return state === "active" || state === "canceling" || state === "past_due";
}

export async function loadBillingSummary(orgId: string): Promise<BillingView> {
  const mode = getBillingMode();
  const plans = getStripePlans();
  if (mode === "off" || !plans) return HIDDEN_VIEW;
  try {
    const secretKey = await getStripeSecretKey();
    if (!secretKey || !stripeKeyMatchesMode(mode, secretKey)) return HIDDEN_VIEW; // transient/dark
    const { customerId, sub } = await withTenantDb((app) =>
      withTenant(app, orgId, async (tx) => ({
        customerId: await readBillingCustomerId(tx),
        sub: await readBillingSummary(tx),
      })),
    );
    const display = sub ? billingDisplayFromSubscription(sub, plans) : null;
    // Offer the upgrade/resubscribe picker unless the org is on an entitled paid plan (switching between
    // paid plans is a separate action, not the picker). Ladder order (pro → scale), configured plans only.
    const upgradePlanIds = isEntitledState(display?.state)
      ? []
      : SELF_SERVE_PLAN_IDS.filter((id) => plans[id]);
    return { hidden: false, display, upgradePlanIds, hasCustomer: customerId !== null };
  } catch (error) {
    logActionError("billing.summary_failed", error);
    return HIDDEN_VIEW;
  }
}
