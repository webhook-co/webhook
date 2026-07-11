import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription } from "@webhook-co/db/reads";
import { appendAuditEntry } from "@webhook-co/db/audit-append";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import {
  isBillingActive,
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

/** Roles allowed to change the plan (mirrors setOverageEnabled's gate). */
function canManage(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Switch `orgId`'s subscription to `targetPlanId`. Gates owner/admin, validates the target + that the sub is
 * a LIVE self-serve plan cleanly on its expected prices, then calls Stripe with immediate proration.
 * @param userId the acting user (gated for owner/admin + audited as the initiator).
 */
export async function switchPlan(
  orgId: string,
  userId: string,
  targetPlanId: string,
): Promise<SwitchPlanResult> {
  if (getBillingMode() === "off") return { status: "disabled" };
  const plans = getStripePlans();
  if (!plans) return { status: "disabled" };
  if (!isSelfServePlan(targetPlanId)) return { status: "unknown_plan" };
  const targetPrices = plans[targetPlanId];
  if (!targetPrices) return { status: "unknown_plan" };
  try {
    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };

    // Read the caller's role + the org's subscription under one tenant-RLS tx (role can't come from another
    // org; the sub is the org's own). No write here — the effect is the Stripe call below.
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
    if (!canManage(role)) return { status: "forbidden" };
    if (!sub) return { status: "no_subscription" };
    // Only a LIVE (entitled) sub can be switched in place. A canceled/lapsed one has no live Stripe sub to
    // update — the user resubscribes via Checkout (which the /billing picker offers).
    if (!isBillingActive(sub.status)) return { status: "no_subscription" };

    const currentPlanId = planIdForBasePrice(plans, sub.plan);
    if (!currentPlanId) return { status: "unknown_plan" }; // on a legacy/archived base price
    if (currentPlanId === targetPlanId) return { status: "same_plan" };
    const currentPrices = plans[currentPlanId];
    if (!currentPrices) return { status: "unknown_plan" };

    // Fetch the live sub's items, remap base+overage to the target plan. planSwitchItems refuses (null) if
    // the sub isn't cleanly on `current`'s prices — never blind-guess which item is the meter.
    const stripeSub = await client.retrieveSubscription(sub.subscriptionId);
    const items = planSwitchItems(stripeSub.items, currentPrices, targetPrices);
    if (!items) return { status: "unknown_plan" };

    await client.updateSubscription({
      subscriptionId: sub.subscriptionId,
      items,
      prorationBehavior: "create_prorations",
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
