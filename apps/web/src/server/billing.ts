import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readBillingCustomerId } from "@webhook-co/db/reads";
import {
  billingEnabled,
  isSelfServePlan,
  makeStripeClient,
  type StripeClient,
} from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getBillingMode, getStripePlans, getStripeSecretKey } from "./env";

// The dashboard billing actions (S4.4b) — hosted Stripe Checkout (upgrade) + Customer Portal (manage).
// Everything is gated on BILLING_MODE: unless it is test/live AND the Stripe key + price ids are configured,
// these no-op ("disabled") so the dashboard shows no billing UI and no Stripe call is ever made. Never
// throws — a Stripe/db fault becomes an "error" state the page renders as a banner, not a 500.

/** Where Checkout success/cancel + the Portal return land (the dashboard usage view). */
const BILLING_RETURN_URL = "https://app.webhook.co/usage";

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
  const secretKey = await getStripeSecretKey();
  return secretKey ? makeStripeClient({ secretKey }) : null;
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
