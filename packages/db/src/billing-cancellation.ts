// Drain for the org_billing_cancellations outbox (0075). deleteOrgWithAudit enqueues a row — the
// live stripe_subscription_id of an org being hard-deleted — in the SAME transaction as the delete,
// because the delete cascades billing_subscriptions away and there is no other record of what to
// cancel. This pass reads the pending jobs and cancels each subscription at Stripe.
//
// Idempotency is the whole point: a cancel that partially failed (DB updated but Stripe call lost, or
// vice-versa) must be safely retryable. So `resource_missing` (the subscription is already gone at
// Stripe) is treated as SUCCESS, not an error — a retry after a crash converges rather than looping.
// A transient failure (network, 5xx) leaves the row `pending` with an incremented attempt count and a
// PII-free error category, to be retried next hour, until an attempt cap converts it to `failed` (an
// alarm for a human — never a silent give-up).
//
// Runs as webhook_billing on its own cross-org connection (the retention reconciler's role, which
// already holds the Stripe secret in the apps/api cron). The 0075 policies bound it to pending rows.

import { StripeError } from "@webhook-co/shared";

import type { Sql } from "./client";
import { safeErr } from "./meter-reporter";

/**
 * The cancellation job lifecycle. Mirrors the 0075 CHECK constraint — kept in sync by hand because the
 * SQL migration can't import this — and centralized so the drain's `where status = ...` predicates
 * can never drift from the schema via a silent string typo (a mistyped `'pending'` would compile fine
 * and just stop claiming every job).
 */
export const CANCELLATION_STATUS = {
  pending: "pending",
  canceled: "canceled",
  failed: "failed",
} as const;

/**
 * The Stripe cancel seam — immediate cancellation of one subscription. Injected so the drain is
 * testable against ephemeral Postgres + a fake Stripe without a network. The production adapter is
 * `makeStripeClient(...).cancelSubscription`.
 */
export interface StripeCanceller {
  cancelSubscription(subscriptionId: string): Promise<{ id: string; status: string }>;
}

export interface BillingCancellationDrainDeps {
  /** webhook_billing connection — cross-org read of pending jobs + column-scoped advance. */
  readonly billing: Sql;
  /** The Stripe cancel seam. */
  readonly canceller: StripeCanceller;
  /** Max jobs drained per pass. A backstop far above this product's deletion rate. */
  readonly limit: number;
  /** Attempts (inclusive) after which a still-failing job is marked `failed` and alarmed. */
  readonly maxAttempts: number;
  /** Optional structured logger; only non-PII fields (org id, category) are passed — never sub ids. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface BillingCancellationDrainResult {
  /** Pending jobs claimed this pass. */
  readonly claimed: number;
  /** Jobs whose subscription is now canceled (a fresh cancel OR an already-gone `resource_missing`). */
  readonly canceled: number;
  /**
   * Of `canceled`, how many resolved because Stripe said the subscription was ALREADY GONE
   * (`resource_missing`) rather than a fresh cancel. Surfaced separately as an anomaly signal: a pass
   * where every job is already-gone is the fingerprint of a valid key pointed at the WRONG Stripe
   * account (every real subscription id 404s), which would silently clear the outbox while the real
   * subscriptions keep billing. `stripeKeyMatchesMode` only checks the key PREFIX, not the account, so
   * this is the cheapest guard we have against that blind spot.
   */
  readonly alreadyGone: number;
  /** Jobs that failed transiently (5xx/network/429) and were left pending for a later retry. */
  readonly retried: number;
  /** Jobs marked `failed` (alarmed) — a terminal 4xx, or attempts exhausted. */
  readonly failed: number;
  /** True when the claimed set hit `limit` (more may remain) — the next pass picks them up. */
  readonly capped: boolean;
}

/** One pending cancellation, as the drain reads it (column-scoped to the webhook_billing grant). */
interface PendingCancellation {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
  readonly attempts: number;
}

/**
 * Is this Stripe error the "subscription no longer exists" case that a cancel should treat as DONE?
 * `resource_missing` means the subscription was already deleted at Stripe (a prior attempt that
 * succeeded but whose DB update was lost, or a manual cancel) — so our goal (it isn't billing) is
 * already met. Structural check on the typed StripeError code, not a message match.
 */
function isAlreadyGone(err: unknown): boolean {
  return err instanceof StripeError && err.stripeCode === "resource_missing";
}

/**
 * Is this a TERMINAL failure that retrying won't fix? A 4xx other than 429 (rate limit) is a config or
 * subscription-state problem — a revoked/wrong key (401/403), a malformed request, or an uncancelable
 * state (400) — that will keep failing every hour until a human intervenes. Treating it as retryable
 * would burn the full ~week attempt cap in silence while a deleted paying customer keeps being charged,
 * which is exactly the harm this lane exists to prevent. So a terminal error is marked `failed` and
 * alarmed on the FIRST attempt, not after a week. (`resource_missing` is a 404 but is handled earlier
 * as an idempotent success; 429 and 5xx/network are transient and retry.)
 */
function isTerminalStripeError(err: unknown): boolean {
  return err instanceof StripeError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

/**
 * Run one drain pass over pending Stripe-cancellation jobs. Returns a summary (a cron has no caller);
 * outcomes also go to the structured log so an ops alarm can match `billing.cancel.failed`. Never
 * throws for an individual job — one bad subscription must not stall the rest of the batch.
 */
export async function drainBillingCancellations(
  deps: BillingCancellationDrainDeps,
): Promise<BillingCancellationDrainResult> {
  const { billing, canceller, limit, maxAttempts, log } = deps;

  const jobs = await billing<PendingCancellation[]>`
    select org_id as "orgId", stripe_subscription_id as "stripeSubscriptionId", attempts
    from org_billing_cancellations
    where status = ${CANCELLATION_STATUS.pending}
    order by requested_at
    limit ${limit}`;

  let canceled = 0;
  let alreadyGone = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await canceller.cancelSubscription(job.stripeSubscriptionId);
      await markCanceled(billing, job.orgId);
      canceled += 1;
    } catch (err) {
      if (isAlreadyGone(err)) {
        // Already canceled/deleted at Stripe — our objective (it isn't billing) is met. Idempotent
        // success, but counted separately: an all-already-gone pass fingerprints a wrong-account key.
        await markCanceled(billing, job.orgId);
        canceled += 1;
        alreadyGone += 1;
        continue;
      }
      const detail = JSON.stringify(safeErr(err));
      const nextAttempts = job.attempts + 1;
      const terminal = isTerminalStripeError(err);
      if (terminal || nextAttempts >= maxAttempts) {
        // Terminal now (a 4xx that retrying won't fix) OR out of retries: stop and alarm. A deleted
        // org whose subscription we cannot cancel is still being charged — a human must see it, and a
        // terminal error surfaces on the FIRST attempt rather than after a silent week of retries.
        await markFailed(billing, job.orgId, detail);
        failed += 1;
        log?.("billing.cancel.failed", {
          orgId: job.orgId,
          attempts: nextAttempts,
          terminal,
          ...safeErr(err),
        });
      } else {
        // Transient (5xx/network/429): leave pending, bump the count, retry next pass.
        await recordAttempt(billing, job.orgId, detail);
        retried += 1;
        log?.("billing.cancel.retry", {
          orgId: job.orgId,
          attempts: nextAttempts,
          ...safeErr(err),
        });
      }
    }
  }

  return {
    claimed: jobs.length,
    canceled,
    alreadyGone,
    retried,
    failed,
    capped: jobs.length >= limit,
  };
}

/** Terminal success: the subscription is canceled. Guarded on `status = 'pending'` (the update policy). */
async function markCanceled(billing: Sql, orgId: string): Promise<void> {
  await billing`
    update org_billing_cancellations
    set status = ${CANCELLATION_STATUS.canceled}, canceled_at = now(), last_error = null
    where org_id = ${orgId} and status = ${CANCELLATION_STATUS.pending}`;
}

/** Transient failure: bump attempts, record the scrubbed error, leave pending for the next pass. */
async function recordAttempt(billing: Sql, orgId: string, lastError: string): Promise<void> {
  await billing`
    update org_billing_cancellations
    set attempts = attempts + 1, last_error = ${lastError}
    where org_id = ${orgId} and status = ${CANCELLATION_STATUS.pending}`;
}

/** Terminal failure: mark `failed` so it stops retrying and a human is alarmed (still bumps attempts). */
async function markFailed(billing: Sql, orgId: string, lastError: string): Promise<void> {
  await billing`
    update org_billing_cancellations
    set status = ${CANCELLATION_STATUS.failed}, attempts = attempts + 1, last_error = ${lastError}
    where org_id = ${orgId} and status = ${CANCELLATION_STATUS.pending}`;
}
