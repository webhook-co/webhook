import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readActiveSubscription, readUsageSummary } from "@webhook-co/db/reads";
import { appendAuditEntry } from "@webhook-co/db/audit-append";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import {
  baseFeeRefundMinorUnits,
  isBillingActive,
  isBillingManagerRole,
  StripeError,
  type StripeClient,
  type StripeInvoice,
  type StripePlans,
} from "@webhook-co/shared";

import { stripeClientFromEnv } from "./billing";
import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getBillingMode, getStripePlans } from "./env";

// Cancel-with-usage-refund (data-lifecycle slice 2.4) — the code behind the promise in the Terms: cancel
// immediately, and give back the prepaid base fee "in proportion to how little of your plan's included volume
// you consumed", rather than by counting calendar days. Overage is billed in arrears, so the base fee is the
// only prepaid money there is to return.
//
// ── The invariant everything here serves ──────────────────────────────────────────────────────────────────
// EVERY figure comes from the invoice that ACTUALLY TOOK THE MONEY — never from live subscription state.
// The first version of this file read the base price from the live subscription and searched for the most
// recent *paid* invoice, and a security review found four ways that moves wrong money:
//
//   · a `past_due` sub's current invoice is `open`, so "latest paid" silently reaches back to the PREVIOUS,
//     fully-consumed period — and this period's ~0 usage would refund ~100% of it. Money out of nothing.
//   · a mid-cycle plan switch (WS4, `create_prorations`) issues no invoice, so live items hold the NEW price
//     while the paid invoice holds the OLD one → no line matched → a silent €0 refund for every customer who
//     ever switched plans, under a banner promising their money back.
//   · an invoice line's `amount` is PRE-discount, so a coupon computes a refund larger than the charge.
//   · a credit-settled invoice has no charge to reverse, and reporting success there writes a signed audit
//     record of a refund that never happened.
//
// So: anchor to `subscription.latest_invoice` (this period's invoice, paid or not), require it to be `paid`,
// sum the base lines net of discounts, take the included volume from THAT invoice's base price, and clamp the
// result to what the charge can still give back. When any of that can't be established, we cancel anyway and
// say so honestly — we never claim a refund we did not make.
//
// ── Two orderings, both about money ───────────────────────────────────────────────────────────────────────
// 1. CANCEL, THEN REFUND. A failed refund after a successful cancel leaves a debt: recorded in the audit log,
//    visible, and payable by hand. Refunding first and then failing to cancel would keep CHARGING a customer
//    we had already paid back — a breach of the exact thing they asked us to stop.
// 2. The refund's Idempotency-Key is derived from the paid INVOICE, so two concurrent cancels collapse to ONE
//    refund at Stripe. A per-click nonce would mint a fresh key per attempt and refund the same money twice.
//
// Stripe's own cancel-time proration is off (`prorate=false`): our refund is usage-based, and letting Stripe
// also credit the unused TIME would pay the customer twice for the same period.

export type CancelRefundResult =
  /** Cancelled, and any refund owed was issued. `refundMinorUnits` is what we sent back (0 = nothing owed). */
  | { readonly status: "ok"; readonly refundMinorUnits: number; readonly currency: string | null }
  /**
   * Cancelled, and we believe a refund is owed but COULD NOT issue it automatically — there was no charge to
   * reverse (credit-settled), or we couldn't identify what the base fee was. Never reported as `ok`: telling
   * the user money is on its way when it isn't is worse than telling them nothing.
   */
  | { readonly status: "refund_unavailable"; readonly refundMinorUnits: number }
  /**
   * Cancelled at Stripe, but the refund CALL failed. Distinct from `error` on purpose: the cancellation
   * STANDS, and a user told "cancellation failed" would cancel again while we still owe them money.
   */
  | { readonly status: "refund_failed"; readonly refundMinorUnits: number }
  /** BILLING_MODE off, or the Stripe key / plans aren't configured — the whole subsystem is dark. */
  | { readonly status: "disabled" }
  /** Not an owner/admin — cancelling is a billing action (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** Nothing live to cancel (never subscribed, or Stripe already shows it cancelled/lapsed). */
  | { readonly status: "no_subscription" }
  | { readonly status: "error" };

/** What the paid invoice tells us we may give back, and against which charge. */
interface RefundBasis {
  /** The base fee actually captured for THIS period, net of discounts. 0 when nothing is refundable. */
  readonly baseMinorUnits: number;
  /** The included volume of the plan that invoice bought (null = unlimited/unknown → no proportion). */
  readonly included: number | null;
  /** The charge to reverse. Null when the invoice was settled without one (credit/balance). */
  readonly charge: string | null;
  /** True when money WAS taken but we could not identify the base line — a human needs to look. */
  readonly unresolved: boolean;
}

/**
 * Work out what may be refunded from the invoice that actually took this period's money. Returns a zero basis
 * (nothing to refund) whenever the current period was not paid — which is the correct answer for a `past_due`
 * cancellation, whose current-period invoice is still `open`.
 */
async function refundBasis(
  client: StripeClient,
  plans: StripePlans,
  invoice: StripeInvoice | null,
): Promise<RefundBasis> {
  const none: RefundBasis = {
    baseMinorUnits: 0,
    included: null,
    charge: null,
    unresolved: false,
  };
  // No invoice, or the current period's invoice was never PAID → nothing was prepaid, so nothing comes back.
  if (!invoice || invoice.status !== "paid" || invoice.amountPaidMinorUnits <= 0) return none;

  // Every base price this deploy sells — the invoice's own base line may belong to a plan the subscription
  // has since switched away from, which is exactly the point: we refund what they PAID for.
  const basePrices = new Set(Object.values(plans).map((p) => p.base));
  const baseLines = invoice.lines.filter((l) => l.priceId && basePrices.has(l.priceId));

  if (baseLines.length === 0) {
    // Money was taken, but none of it maps to a base price we recognise (an archived/legacy price). Refunding
    // 0 under an "all done" banner would be a silent under-refund — surface it instead.
    return { ...none, charge: invoice.charge, unresolved: true };
  }

  // SUM the base lines, don't take the first: a proration invoice carries several lines on the same price,
  // and one of them can be a NEGATIVE credit. Net each line's discount off it — Stripe's line `amount` is
  // pre-discount, so a coupon would otherwise compute a refund bigger than the charge.
  const baseMinorUnits = baseLines.reduce(
    (sum, l) => sum + l.amountMinorUnits - l.discountMinorUnits,
    0,
  );

  // The included volume of the plan THIS INVOICE bought — read from that price's metadata, not from the live
  // subscription's mirrored cap (which after a plan switch describes a different plan entirely).
  const basePriceId = baseLines[0]?.priceId;
  const included = basePriceId ? (await client.retrievePrice(basePriceId)).eventCap : null;

  return { baseMinorUnits, included, charge: invoice.charge, unresolved: false };
}

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

  let cancelled = false;
  let owed = 0;
  try {
    // Gate + measure in ONE tenant-RLS tx: the caller's role, the org's subscription, and the events consumed
    // this period. Reject a non-manager before any Stripe call is made.
    const now = Date.now();
    const { role, sub, consumed } = await withTenantDb((app) =>
      withTenant(app, orgId, async (tx) => {
        const roleRow = await tx<{ role: string }[]>`
          select role from memberships where user_id = ${userId} limit 1`;
        const activeSub = await readActiveSubscription(tx);
        // The same basis the soft cap enforces on, so a refund can't disagree with what we metered them for.
        const usage = activeSub ? await readUsageSummary(tx, now) : null;
        return { role: roleRow[0]?.role ?? null, sub: activeSub, consumed: usage?.events ?? 0 };
      }),
    );
    if (!isBillingManagerRole(role)) return { status: "forbidden" };
    if (!sub) return { status: "no_subscription" };

    const client = await stripeClientFromEnv();
    if (!client) return { status: "disabled" };

    // LIVE Stripe state decides, not the mirror (which lags a webhook). This also makes a double-submit a
    // clean no_subscription on the second pass rather than a second cancel and a second refund attempt.
    const stripeSub = await client.retrieveSubscription(sub.subscriptionId);
    if (!isBillingActive(stripeSub.status)) return { status: "no_subscription" };

    // THIS period's invoice — paid or not. Never a search for the latest *paid* one (see the header).
    const invoice = stripeSub.latestInvoiceId
      ? await client.retrieveInvoice(stripeSub.latestInvoiceId)
      : null;
    const basis = await refundBasis(client, plans, invoice);

    owed = baseFeeRefundMinorUnits({
      baseMinorUnits: basis.baseMinorUnits,
      consumed,
      included: basis.included,
    });
    // Hard ceiling: never give back more than this invoice actually captured.
    owed = Math.min(owed, invoice?.amountPaidMinorUnits ?? 0);

    // Clamp to what the charge can STILL return — support, or the Portal, may already have refunded part of
    // it. Without this, Stripe rejects the over-refund and we record a debt we don't actually owe.
    if (owed > 0 && basis.charge) {
      const charge = await client.retrieveCharge(basis.charge);
      owed = Math.min(owed, charge.amountMinorUnits - charge.amountRefundedMinorUnits);
    }
    owed = Math.max(owed, 0);

    // ── The cancel comes first. See (1) in the header. ─────────────────────────────────────────────────────
    await client.cancelSubscription({
      subscriptionId: sub.subscriptionId,
      idempotencyKey: `cancel:${sub.subscriptionId}`,
    });
    cancelled = true;

    // We couldn't work out what the base fee was, though money was taken. Cancel stands; a human must look.
    if (basis.unresolved) {
      logActionError(
        "billing.cancel_base_line_unresolved",
        new Error("no recognised base line on the paid invoice"),
      );
      await auditCancel(orgId, userId, 0, "subscription_canceled_refund_unavailable");
      return { status: "refund_unavailable", refundMinorUnits: 0 };
    }

    // Money is owed but there is no charge to reverse (the invoice was settled from credit/balance). Say so —
    // never report `ok`, which would promise the user a refund AND audit one that never happened.
    if (owed > 0 && !basis.charge) {
      await auditCancel(orgId, userId, owed, "subscription_canceled_refund_unavailable");
      return { status: "refund_unavailable", refundMinorUnits: owed };
    }

    if (owed > 0 && basis.charge) {
      await client.createRefund({
        charge: basis.charge,
        amountMinorUnits: owed,
        reason: "requested_by_customer",
        // Keyed on the invoice: concurrent cancels refund the SAME money once. See (2) in the header.
        idempotencyKey: `refund:${sub.subscriptionId}:${invoice?.id ?? "none"}`,
      });
    }

    await auditCancel(orgId, userId, owed, "subscription_canceled");
    return { status: "ok", refundMinorUnits: owed, currency: invoice?.currency ?? null };
  } catch (error) {
    if (cancelled) {
      // The subscription IS cancelled and we could not return the money. Say exactly that, and record the debt
      // in the audit log so it is recoverable from durable state rather than only from a log line.
      // NOTE: there is no automatic retry — a re-cancel would see the sub already cancelled and stop before
      // the refund. Recovery is a human reading the audit row and refunding in Stripe. A refund-recovery job
      // is tracked as follow-up; do not describe this path as self-healing until that exists.
      logActionError("billing.cancel_refund_failed", sanitize(error));
      await auditCancel(orgId, userId, owed, "subscription_canceled_refund_failed");
      return { status: "refund_failed", refundMinorUnits: owed };
    }
    logActionError("billing.cancel_failed", sanitize(error));
    return { status: "error" };
  }
}

/** Stripe's free-text error messages routinely embed `ch_…`/`cus_…` ids — org-linkable payment identifiers we
 *  don't want in Workers logs. Keep the structured type/code/status, drop the prose. */
function sanitize(error: unknown): Error {
  return error instanceof StripeError
    ? new Error(`stripe ${error.status} ${error.stripeType ?? ""} ${error.stripeCode ?? ""}`.trim())
    : error instanceof Error
      ? new Error(error.name)
      : new Error("unknown");
}

/** Audit the initiator + the money. Best-effort: the cancel already stands at Stripe, so a failed audit must
 *  never be reported to the user as a failed cancellation. */
async function auditCancel(
  orgId: string,
  userId: string,
  refundMinorUnits: number,
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
          target: `refund minor units: ${refundMinorUnits}`,
        }),
      ),
    );
  } catch (error) {
    logActionError("billing.cancel_audit_failed", sanitize(error));
  }
}
