import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription, readUsageSummary } from "@webhook-co/db/reads";
import { appendAuditEntry } from "@webhook-co/db/audit-append";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { baseFeeRefundMinorUnits, isBillingActive, isBillingManagerRole } from "@webhook-co/shared";

import { stripeClientFromEnv } from "./billing";
import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getBillingMode, getStripePlans } from "./env";

// Cancel-with-usage-refund (data-lifecycle slice 2.4) — the code behind the promise in the Terms: cancel
// immediately, and give back the prepaid base fee "in proportion to how little of your plan's included volume
// you consumed", rather than by counting calendar days. Overage is billed in arrears, so the base fee is the
// only prepaid money there is to return.
//
// Two decisions here are load-bearing, and both are about money:
//
// 1. ORDER — cancel, THEN refund. If the refund leg fails after a successful cancel we owe a debt we can
//    detect, audit, and retry (the key below makes the retry safe). If we refunded first and the cancel then
//    failed, we would keep CHARGING a customer we had already paid back. Owing someone money is recoverable;
//    silently continuing to bill them is a breach of the thing they just asked us to stop doing.
//
// 2. IDEMPOTENCY — the refund key is derived from the paid INVOICE, not from a per-click nonce. Two
//    independent cancel attempts against the same invoice therefore collapse to ONE refund at Stripe. A
//    nonce would give each attempt a fresh key and refund the same money twice.
//
// Stripe's own cancel-time proration is switched OFF (`prorate=false` in cancelSubscription): our refund is
// usage-based, and letting Stripe also credit the unused TIME would pay the customer twice over.
//
// No amount is computed from anything in this repo — `base` is read from the Stripe invoice that actually
// took the money. (parseStripePlans rejects a config carrying an `amount`; there are no price figures here.)

export type CancelRefundResult =
  /** Canceled. `refundMinorUnits` is what we sent back (0 = nothing was owed). */
  | {
      readonly status: "ok";
      readonly refundMinorUnits: number;
      readonly currency: string | null;
    }
  /**
   * Canceled at Stripe, but the refund call failed. DISTINCT from "error" on purpose: the cancellation
   * STANDS, and the UI must say so — telling the user it failed would have them cancel again while we still
   * owe them money. `refundMinorUnits` is the amount owed, so support/retry has the figure.
   */
  | { readonly status: "refund_failed"; readonly refundMinorUnits: number }
  /** BILLING_MODE off, or the Stripe key / plans aren't configured — the whole subsystem is dark. */
  | { readonly status: "disabled" }
  /** Not an owner/admin — canceling is a billing action (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** Nothing live to cancel (never subscribed, or Stripe already shows it canceled/lapsed). */
  | { readonly status: "no_subscription" }
  | { readonly status: "error" };

/**
 * Cancel `orgId`'s subscription immediately and refund the unused portion of its prepaid base fee.
 * @param userId the acting user — gated for owner/admin and audited as the initiator.
 */
export async function cancelSubscriptionWithRefund(
  orgId: string,
  userId: string,
): Promise<CancelRefundResult> {
  if (getBillingMode() === "off") return { status: "disabled" };
  const plans = getStripePlans();
  if (!plans) return { status: "disabled" };

  let canceled = false;
  let owed = 0;
  try {
    // Gate + measure in ONE tenant-RLS tx: the caller's role, the org's subscription (with the included
    // volume it BOUGHT), and the events consumed this period. Reject a non-manager before any Stripe call.
    const now = Date.now();
    const { role, sub, consumed } = await withTenantDb((app) =>
      withTenant(app, orgId, async (tx) => {
        const roleRow = await tx<{ role: string }[]>`
          select role from memberships where user_id = ${userId} limit 1`;
        const activeSub = await readActiveSubscription(tx);
        // Same basis the soft cap enforces on, so the refund can't disagree with what we metered them for.
        const usage = activeSub ? await readUsageSummary(tx, now) : null;
        return {
          role: roleRow[0]?.role ?? null,
          sub: activeSub,
          consumed: usage?.events ?? 0,
        };
      }),
    );
    if (!isBillingManagerRole(role)) return { status: "forbidden" };
    if (!sub) return { status: "no_subscription" };

    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };

    // LIVE Stripe state decides, not the mirror (which lags a webhook). This also makes a double-submit a
    // clean no_subscription on the second pass rather than a second cancel + a second refund attempt.
    const stripeSub = await client.retrieveSubscription(sub.subscriptionId);
    if (!isBillingActive(stripeSub.status)) return { status: "no_subscription" };

    // The invoice that actually took this period's money — the ONLY source of the base amount + the charge.
    const invoice = await client.retrieveLatestPaidInvoice(sub.subscriptionId);
    // Which price is the base for the plan this sub is really on (derived from live items, not the mirror).
    const basePriceId = stripeSub.items
      .map((it) => it.price)
      .find((price) => Object.values(plans).some((p) => p.base === price));
    const baseMinorUnits =
      invoice && basePriceId
        ? (invoice.lines.find((l) => l.priceId === basePriceId)?.amountMinorUnits ?? 0)
        : 0;

    owed = baseFeeRefundMinorUnits({
      baseMinorUnits,
      consumed,
      included: sub.eventCap,
    });

    // ── The cancel comes first. See (1) above. ──────────────────────────────────────────────────────────
    await client.cancelSubscription({
      subscriptionId: sub.subscriptionId,
      idempotencyKey: `cancel:${sub.subscriptionId}`,
    });
    canceled = true;

    // Only move money when there IS money to move and something to move it against. A zero-amount refund is
    // a bug (createRefund refuses it), and a credit-settled invoice has no charge to reverse.
    if (owed > 0 && invoice?.charge) {
      await client.createRefund({
        charge: invoice.charge,
        amountMinorUnits: owed,
        reason: "requested_by_customer",
        // Keyed on the invoice: independent retries of this cancel refund the SAME money once. See (2).
        idempotencyKey: `refund:${sub.subscriptionId}:${invoice.id}`,
      });
    }

    await auditCancel(orgId, userId, owed);
    return { status: "ok", refundMinorUnits: owed, currency: invoice?.currency ?? null };
  } catch (error) {
    if (canceled) {
      // The subscription IS canceled and we could not return the money. Say exactly that — and record the
      // debt in the audit log so it is recoverable from durable state, not just from a log line.
      logActionError("billing.cancel_refund_failed", error);
      await auditCancel(orgId, userId, owed, { refundFailed: true });
      return { status: "refund_failed", refundMinorUnits: owed };
    }
    logActionError("billing.cancel_failed", error);
    return { status: "error" };
  }
}

/** Audit the initiator + the money. Best-effort: the cancel already stands at Stripe, so a failed audit must
 *  never be reported to the user as a failed cancellation. */
async function auditCancel(
  orgId: string,
  userId: string,
  refundMinorUnits: number,
  opts: { refundFailed?: boolean } = {},
): Promise<void> {
  try {
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    await withTenantDb((app) =>
      withTenant(app, orgId, (tx) =>
        appendAuditEntry(tx, auditKey, {
          orgId,
          actor: userId,
          action: opts.refundFailed
            ? "subscription_canceled_refund_failed"
            : "subscription_canceled",
          target: `refund minor units: ${refundMinorUnits}`,
        }),
      ),
    );
  } catch (error) {
    logActionError("billing.cancel_audit_failed", error);
  }
}
