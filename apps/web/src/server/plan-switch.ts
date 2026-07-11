import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription } from "@webhook-co/db/reads";
import { appendAuditEntry } from "@webhook-co/db/audit-append";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import {
  isBillingActive,
  isBillingManagerRole,
  isSelfServePlan,
  planIdForBasePrice,
  planSwitchItems,
} from "@webhook-co/shared";

import { stripeClientFromEnv } from "./billing";
import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getBillingMode, getStripePlans } from "./env";

// In-dashboard plan switching (WS4). An owner/admin swaps a live subscription's plan (Pro↔Scale) by
// remapping its Stripe price items and letting Stripe PRORATE immediately (create_prorations — founder
// choice): an upgrade charges the prorated difference now, a downgrade credits unused time to the account.
// The subscription.updated webhook then syncs the new plan + cap into the mirror (existing handler), so this
// makes NO local mirror write — only the Stripe mutation + an audit of who initiated it. Never throws.
//
// The CURRENT plan is derived from LIVE Stripe state (retrieveSubscription), not the local mirror, because
// the mirror lags a switch until its webhook lands: a mirror-based decision would show a "switch to X" button
// right after moving to X and then fail confusingly. Live state also makes a retried/duplicate switch a
// clean same_plan (the sub is already on the target).

export type SwitchPlanResult =
  | { readonly status: "ok"; readonly plan: string }
  /** BILLING_MODE off, or the Stripe key / plans aren't configured. */
  | { readonly status: "disabled" }
  /** The target isn't a self-serve plan this deploy sells, or the sub is on a legacy price we can't map. */
  | { readonly status: "unknown_plan" }
  /** Not an owner/admin — a plan change is admin-only (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** No live subscription to switch (unsubscribed/canceled/lapsed → the user must (re)subscribe via Checkout). */
  | { readonly status: "no_subscription" }
  /** Already on the requested plan — nothing to do. */
  | { readonly status: "same_plan" }
  | { readonly status: "error" };

/**
 * Switch `orgId`'s subscription to `targetPlanId`. Gates owner/admin, validates the target + that the sub is
 * a LIVE self-serve plan cleanly on its expected prices, then calls Stripe with immediate proration.
 * @param userId the acting user (gated for owner/admin + audited as the initiator).
 * @param idempotencyKey a per-form-render nonce (from the ChangePlanCard) so a double-submit collapses to one
 *   Stripe update — a fresh render gets a fresh nonce, so a legitimate later switch is never blocked.
 */
export async function switchPlan(
  orgId: string,
  userId: string,
  targetPlanId: string,
  idempotencyKey?: string,
): Promise<SwitchPlanResult> {
  if (getBillingMode() === "off") return { status: "disabled" };
  const plans = getStripePlans();
  if (!plans) return { status: "disabled" };
  if (!isSelfServePlan(targetPlanId)) return { status: "unknown_plan" };
  const targetPrices = plans[targetPlanId];
  if (!targetPrices) return { status: "unknown_plan" };
  try {
    // Gate FIRST — read the caller's role + the org's subscription id under one tenant-RLS tx (the role can't
    // come from another org; the sub is the org's own), and reject a non-manager BEFORE resolving the Stripe
    // secret or making any Stripe call. No write here — the effect is the Stripe call below.
    const { role, sub } = await withTenantDb((app) =>
      withTenant(app, orgId, async (tx) => ({
        role:
          (
            await tx<
              { role: string }[]
            >`select role from memberships where user_id = ${userId} limit 1`
          )[0]?.role ?? null,
        sub: await readActiveSubscription(tx),
      })),
    );
    if (!isBillingManagerRole(role)) return { status: "forbidden" };
    if (!sub) return { status: "no_subscription" };

    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };

    // LIVE state is authoritative for the switch decision (the mirror lags). Retrieve the sub, check it's
    // still entitled, and derive the CURRENT plan from its actual items — not the possibly-stale mirror.
    const stripeSub = await client.retrieveSubscription(sub.subscriptionId);
    if (!isBillingActive(stripeSub.status)) return { status: "no_subscription" };
    const currentPlanId =
      stripeSub.items.map((it) => planIdForBasePrice(plans, it.price)).find(Boolean) ?? null;
    if (!currentPlanId) return { status: "unknown_plan" }; // on a legacy/archived base price
    if (currentPlanId === targetPlanId) return { status: "same_plan" }; // already there (incl. a lagged retry)
    const currentPrices = plans[currentPlanId];
    if (!currentPrices) return { status: "unknown_plan" };

    // Remap base+overage to the target. planSwitchItems refuses (null) unless the sub is cleanly on exactly
    // `current`'s two items — never blind-guess which item is the meter, never leave a stray item behind.
    const items = planSwitchItems(stripeSub.items, currentPrices, targetPrices);
    if (!items) return { status: "unknown_plan" };

    // idempotencyKey = the form-render nonce: a double-submit of the same button carries the same key, so
    // Stripe processes the update once and returns the cached result for the duplicate — no double proration.
    await client.updateSubscription({
      subscriptionId: sub.subscriptionId,
      items,
      prorationBehavior: "create_prorations",
      idempotencyKey,
    });

    // Audit the initiator (the webhook records the OUTCOME, not who asked). Best-effort — the switch already
    // stands at Stripe; a failed audit must not report the switch as failed.
    try {
      const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
      await withTenantDb((app) =>
        withTenant(app, orgId, (tx) =>
          appendAuditEntry(tx, auditKey, {
            orgId,
            actor: userId,
            action: "plan_switched",
            target: `plan: ${currentPlanId} -> ${targetPlanId}`,
          }),
        ),
      );
    } catch (error) {
      logActionError("billing.plan_switch_audit_failed", error);
    }

    return { status: "ok", plan: targetPlanId };
  } catch (error) {
    logActionError("billing.plan_switch_failed", error);
    return { status: "error" };
  }
}
