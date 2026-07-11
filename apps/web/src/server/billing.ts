import "server-only";

import { withTenant } from "@webhook-co/db/client";
import {
  readActiveSubscription,
  readBillingCustomerId,
  readBillingSummary,
  readOveragePolicy,
} from "@webhook-co/db/reads";
import {
  billingDisplayFromSubscription,
  billingEnabled,
  isBillingActive,
  isBillingManagerRole,
  isLiveSubscriptionStatus,
  isSelfServePlan,
  makeStripeClient,
  pendingPlanChangeFromPhases,
  SELF_SERVE_PLAN_IDS,
  stripeKeyMatchesMode,
  type BillingDisplay,
  type BillingSubscriptionSummary,
  type PendingPlanChange,
  type SelfServePlanId,
  type StripeClient,
  type StripePlans,
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
  /** The org already has a LIVE subscription — a new Checkout would double-subscribe it. Manage via Portal. */
  | { readonly status: "already_subscribed" }
  | { readonly status: "error" };

/** The org's Stripe customer id (if any), its synced subscription mirror row (if any), its overage policy
 *  (null when there's no paid org_limits row), and — when `userId` is given — the caller's membership role,
 *  read together under one tenant-RLS transaction. Drives the already-subscribed guard, the picker, and the
 *  overage toggle (whose button is shown only to an owner/admin). */
async function readOrgBilling(
  orgId: string,
  userId?: string,
): Promise<{
  customerId: string | null;
  sub: BillingSubscriptionSummary | null;
  /** The Stripe subscription id — needed to read back a booked downgrade from its schedule. */
  subscriptionId: string | null;
  overagePolicy: "pause" | "allow" | null;
  role: string | null;
}> {
  return withTenantDb((app) =>
    withTenant(app, orgId, async (tx) => ({
      customerId: await readBillingCustomerId(tx),
      sub: await readBillingSummary(tx),
      subscriptionId: (await readActiveSubscription(tx))?.subscriptionId ?? null,
      overagePolicy: await readOveragePolicy(tx),
      role: userId
        ? ((
            await tx<
              { role: string }[]
            >`select role from memberships where user_id = ${userId} limit 1`
          )[0]?.role ?? null)
        : null,
    })),
  );
}

/** Build the Stripe client from env, or null when billing isn't fully configured (key missing). Exported so
 *  the plan-switch orchestration reuses the SAME mode-match guard (a live key under test mode never builds). */
export async function stripeClientFromEnv(): Promise<StripeClient | null> {
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
    const { customerId, sub } = await readOrgBilling(orgId);
    // Money backstop — the SAME rule the UI picker gates on (canStartNewCheckout), enforced server-side so
    // a forged/stale server-action POST can't bypass it. Refuse a fresh Checkout unless it provably can't
    // create a duplicate: a LIVE mirrored sub (active/trialing/past_due/unpaid/paused/incomplete) or a
    // customer that exists with NO mirror row (possibly an unmirrored live sub) both refuse; only a truly
    // new org (no customer) or a TERMINAL sub (canceled/incomplete_expired — subscription.deleted keeps the
    // row as `canceled`, so a resubscribe still passes) proceeds. Residual: a live Stripe sub we have NEVER
    // mirrored is invisible here — a Stripe-side subscription read is deferred to WS4 where that seam exists.
    if (!canStartNewCheckout(customerId, sub)) return { status: "already_subscribed" };
    const session = await client.createCheckoutSession({
      customer: customerId ?? undefined,
      customerEmail: customerId ? undefined : email,
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
    const { customerId } = await readOrgBilling(orgId);
    if (!customerId) return { status: "no_customer" };
    const session = await client.createPortalSession({
      customer: customerId,
      returnUrl: BILLING_RETURN_URL,
    });
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
  /** Whether overage billing is currently ON (pause_policy 'allow'), or null when the org has no paid plan
   *  (no org_limits row) so the toggle doesn't apply. Drives the overage card's visibility + state. */
  readonly overageEnabled: boolean | null;
  /** Whether the caller may CHANGE billing policy (owner/admin) — gates the overage toggle button so a plain
   *  member sees the state read-only instead of a dead button the server would reject (SEC-RLS-08). */
  readonly canManageBilling: boolean;
  /** The self-serve plans this org can SWITCH to in place (WS4) — the other configured plans, when it's on a
   *  LIVE self-serve subscription. Empty when there's nothing to switch (unsubscribed/canceled/legacy price). */
  readonly switchTargets: readonly SelfServePlanId[];
  /** A downgrade already BOOKED with Stripe for the end of the current period, if any (ADR-0112). Read live
   *  from the subscription's schedule, so it can never go stale. null = nothing pending. */
  readonly pendingDowngrade: PendingPlanChange | null;
}

const HIDDEN_VIEW: BillingView = {
  hidden: true,
  display: null,
  upgradePlanIds: [],
  hasCustomer: false,
  overageEnabled: null,
  canManageBilling: false,
  switchTargets: [],
  pendingDowngrade: null,
};

/**
 * Read back the downgrade (if any) already booked for the end of the period, straight from Stripe's schedule.
 *
 * BEST-EFFORT by design: this is the only Stripe call the billing page makes, and a Stripe blip must not blank
 * the entire billing panel (the caller's catch would fall through to HIDDEN_VIEW). On any fault we log and
 * return null — the page renders, just without the pending-downgrade notice.
 */
async function readPendingDowngrade(
  client: StripeClient,
  plans: StripePlans,
  subscriptionId: string,
  nowSeconds: number,
): Promise<PendingPlanChange | null> {
  try {
    const stripeSub = await client.retrieveSubscription(subscriptionId);
    if (!stripeSub.scheduleId) return null;
    const schedule = await client.retrieveSubscriptionSchedule(stripeSub.scheduleId);
    return pendingPlanChangeFromPhases(schedule.phases, plans, nowSeconds);
  } catch (error) {
    logActionError("billing.pending_downgrade_read_failed", error);
    return null;
  }
}

/**
 * Whether it is safe to offer a NEW-subscription Checkout (the upgrade/resubscribe picker) — i.e. the org
 * has NO live subscription that a fresh Checkout would duplicate. Safe cases:
 *   - no Stripe customer at all → a genuinely new subscriber;
 *   - a terminal sub (canceled / incomplete_expired) → a legitimate resubscribe.
 * NOT safe (→ no picker, route to the Portal instead):
 *   - any live sub (active/trialing/past_due/unpaid/paused/incomplete) → a new Checkout double-subscribes;
 *   - a customer with NO mirror row → could be an unmirrored live sub, so we decline to invite Checkout.
 * This mirrors the `startCheckout` backstop and is what closes the double-subscribe regression.
 */
function canStartNewCheckout(
  customerId: string | null,
  sub: BillingSubscriptionSummary | null,
): boolean {
  if (sub) return !isLiveSubscriptionStatus(sub.status);
  return customerId === null;
}

export async function loadBillingSummary(orgId: string, userId: string): Promise<BillingView> {
  const mode = getBillingMode();
  const plans = getStripePlans();
  if (mode === "off" || !plans) return HIDDEN_VIEW;
  try {
    const secretKey = await getStripeSecretKey();
    if (!secretKey || !stripeKeyMatchesMode(mode, secretKey)) return HIDDEN_VIEW; // transient/dark
    const { customerId, sub, subscriptionId, overagePolicy, role } = await readOrgBilling(
      orgId,
      userId,
    );
    const display = sub ? billingDisplayFromSubscription(sub, plans) : null;
    // Offer the picker ONLY when a new Checkout can't create a duplicate subscription (see
    // canStartNewCheckout). Ladder order (pro → scale), configured plans only.
    const upgradePlanIds = canStartNewCheckout(customerId, sub)
      ? SELF_SERVE_PLAN_IDS.filter((id) => plans[id])
      : [];
    // overageEnabled: null when there's no paid org_limits row (Free/canceled — the toggle doesn't apply),
    // else whether the policy is currently 'allow'.
    const overageEnabled = overagePolicy === null ? null : overagePolicy === "allow";
    // switchTargets: the OTHER configured self-serve plans, offered only when the org is on a LIVE self-serve
    // sub (a known tier + an entitled status). A canceled/legacy sub has nothing to switch in place.
    const currentTier = display && display.tier !== "unknown" ? display.tier : null;
    const switchTargets =
      sub && isBillingActive(sub.status) && currentTier
        ? SELF_SERVE_PLAN_IDS.filter((id) => plans[id] && id !== currentTier)
        : [];
    // Live-read any booked downgrade (best-effort; never blanks the page). Only meaningful for an entitled sub.
    const pendingDowngrade =
      sub && subscriptionId && isBillingActive(sub.status)
        ? await readPendingDowngrade(
            makeStripeClient({ mode, secretKey }),
            plans,
            subscriptionId,
            Math.floor(Date.now() / 1000),
          )
        : null;

    return {
      hidden: false,
      display,
      upgradePlanIds,
      hasCustomer: customerId !== null,
      overageEnabled,
      canManageBilling: isBillingManagerRole(role),
      // Don't offer the plan you're already scheduled to move to — the button would read as a no-op.
      switchTargets: switchTargets.filter((id) => id !== pendingDowngrade?.plan),
      pendingDowngrade,
    };
  } catch (error) {
    logActionError("billing.summary_failed", error);
    return HIDDEN_VIEW;
  }
}
