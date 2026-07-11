import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription } from "@webhook-co/db/reads";
import { appendAuditEntry } from "@webhook-co/db/audit-append";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import {
  isBillingActive,
  isBillingManagerRole,
  isPlanDowngrade,
  isSelfServePlan,
  planIdForBasePrice,
  planSwitchItems,
} from "@webhook-co/shared";

import { stripeClientFromEnv } from "./billing";
import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getBillingMode, getStripePlans } from "./env";

// In-dashboard plan switching (WS4). An owner/admin moves a live subscription between Pro and Scale. The
// DIRECTION decides the money path (ADR-0112), and the asymmetry is deliberate:
//
//   · UPGRADE   → applied IMMEDIATELY, with the difference prorated onto the next invoice. A customer who has
//                 hit their cap needs the headroom now; making them wait for renewal is a bad experience and a
//                 lost sale.
//   · DOWNGRADE → SCHEDULED for the end of the current period, via a Stripe subscription schedule. They keep
//                 the plan they already paid for until it runs out, and NO money flows backward. We never
//                 refund automatically, and an immediate downgrade's proration CREDIT is exactly that — a
//                 refund by another name — so `proration_behavior: none` is load-bearing, not a detail.
//
// The subscription.updated webhook syncs the new plan + cap into the mirror (existing handler), so this makes
// NO local mirror write — only the Stripe mutation + an audit of who initiated it. Never throws.
//
// The CURRENT plan is derived from LIVE Stripe state (retrieveSubscription), not the local mirror, because
// the mirror lags a switch until its webhook lands: a mirror-based decision would show a "switch to X" button
// right after moving to X and then fail confusingly. Live state also makes a retried/duplicate switch a
// clean same_plan (the sub is already on the target).

export type SwitchPlanResult =
  /** An UPGRADE: applied immediately, prorated charge on the next invoice. */
  | { readonly status: "ok"; readonly plan: string }
  /** A DOWNGRADE: scheduled for the end of the current period. Nothing changes today, no money moves. */
  | { readonly status: "scheduled"; readonly plan: string }
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

    const downgrade = isPlanDowngrade(currentPlanId, targetPlanId);

    if (downgrade) {
      // A DOWNGRADE never takes effect today. The customer paid for the bigger plan through the end of this
      // period, so they keep it — and we do NOT credit the remainder back (ADR-0112: we never refund
      // automatically, and a proration credit is money flowing backward by another name). Stripe's native
      // primitive for "change the plan at renewal" is a subscription schedule: phase 0 is the period they
      // already bought, phase 1 is the smaller plan, starting the moment phase 0 runs out.
      //
      // Keyed on subscription + target rather than the per-render nonce: two independent downgrade attempts
      // to the same plan must collapse to ONE schedule at Stripe, not stack up. A fresh nonce would defeat
      // that — and the correct behaviour for a repeated downgrade request is "you already asked for this".
      const scheduleKey = `downgrade:${sub.subscriptionId}:${targetPlanId}`;
      // REUSE an existing schedule rather than creating a second one: a subscription may hold only ONE. Once a
      // downgrade is booked, a repeat request — past Stripe's ~24h idempotency replay window, or aimed at a
      // different tier — would make `createSubscriptionSchedule` fail, and the user would see a generic error
      // on a perfectly reasonable action.
      const schedule = stripeSub.scheduleId
        ? await client.retrieveSubscriptionSchedule(stripeSub.scheduleId)
        : await client.createSubscriptionSchedule({
            fromSubscription: sub.subscriptionId,
            idempotencyKey: scheduleKey,
          });
      await client.updateSubscriptionSchedule({
        scheduleId: schedule.id,
        phases: [
          // Phase 0 verbatim from Stripe — the period already paid for, ending exactly when it ends.
          schedule.currentPhase,
          // Phase 1 carries NO dates: it simply begins when phase 0 runs out. The licensed base takes a
          // quantity; the metered overage must not (Stripe rejects a quantity on a metered price).
          {
            items: [{ price: targetPrices.base, quantity: 1 }, { price: targetPrices.overage }],
          },
        ],
        idempotencyKey: scheduleKey,
      });
      await auditSwitch(orgId, userId, currentPlanId, targetPlanId, "plan_downgrade_scheduled");
      return { status: "scheduled", plan: targetPlanId };
    }

    // ── UPGRADE ───────────────────────────────────────────────────────────────────────────────────────────
    // RELEASE any pending downgrade FIRST. A schedule left attached would still fire its "smaller plan at
    // renewal" phase — so a customer who books Scale→Pro, changes their mind, and upgrades back would pay MORE
    // now and be silently DEMOTED at renewal. Released before the upgrade lands, so there is no window in
    // which both are live.
    if (stripeSub.scheduleId) {
      await client.releaseSubscriptionSchedule({
        scheduleId: stripeSub.scheduleId,
        idempotencyKey: `release:${sub.subscriptionId}:${stripeSub.scheduleId}`,
      });
    }

    // The upgrade applies IMMEDIATELY: a customer who has hit their cap needs the headroom now, and the
    // prorated difference lands on their next invoice. idempotencyKey = the form-render nonce, so a
    // double-submit of the same button collapses to one charge.
    await client.updateSubscription({
      subscriptionId: sub.subscriptionId,
      items,
      prorationBehavior: "create_prorations",
      idempotencyKey,
    });

    await auditSwitch(orgId, userId, currentPlanId, targetPlanId, "plan_switched");
    return { status: "ok", plan: targetPlanId };
  } catch (error) {
    logActionError("billing.plan_switch_failed", error);
    return { status: "error" };
  }
}

/** Audit the initiator (the webhook records the OUTCOME, not who asked). Best-effort — the change already
 *  stands at Stripe, so a failed audit must not report the switch as failed. */
async function auditSwitch(
  orgId: string,
  userId: string,
  from: string,
  to: string,
  action: string,
): Promise<void> {
  try {
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    await withTenantDb((app) =>
      withTenant(app, orgId, (tx) =>
        appendAuditEntry(tx, auditKey, {
          orgId,
          actor: userId,
          action,
          target: `plan: ${from} -> ${to}`,
        }),
      ),
    );
  } catch (error) {
    logActionError("billing.plan_switch_audit_failed", error);
  }
}

export type CancelDowngradeResult =
  | { readonly status: "ok" }
  /** No schedule attached — there was nothing booked to undo. */
  | { readonly status: "nothing_pending" }
  | { readonly status: "disabled" }
  | { readonly status: "forbidden" }
  | { readonly status: "no_subscription" }
  | { readonly status: "error" };

/**
 * Cancel a downgrade that was booked for the end of the period — the UNDO for `switchPlan`'s scheduled path.
 * Releasing the schedule detaches it and leaves the subscription exactly as it is, so the customer simply
 * stays on their current plan and renews normally. No money moves in either direction.
 *
 * Without this, a downgrade is a one-way door: a user who changes their mind has no way back except
 * upgrading (which is a charge) or contacting support.
 */
export async function cancelPendingDowngrade(
  orgId: string,
  userId: string,
): Promise<CancelDowngradeResult> {
  if (getBillingMode() === "off") return { status: "disabled" };
  if (!getStripePlans()) return { status: "disabled" };
  try {
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

    const stripeSub = await client.retrieveSubscription(sub.subscriptionId);
    if (!stripeSub.scheduleId) return { status: "nothing_pending" };

    await client.releaseSubscriptionSchedule({
      scheduleId: stripeSub.scheduleId,
      idempotencyKey: `release:${sub.subscriptionId}:${stripeSub.scheduleId}`,
    });
    await auditSwitch(orgId, userId, "scheduled", "kept", "plan_downgrade_cancelled");
    return { status: "ok" };
  } catch (error) {
    logActionError("billing.cancel_downgrade_failed", error);
    return { status: "error" };
  }
}
