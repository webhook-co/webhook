// Cron shell for the org_billing_cancellations drain (0075). deleteOrgWithAudit enqueues a row when
// a deleted org still had a live Stripe subscription; this hourly pass cancels each at Stripe so a
// deleted paying customer stops being charged. The pure drain logic lives in @webhook-co/db
// (drainBillingCancellations); this is the thin workerd wiring — build the Stripe client + the
// webhook_billing connection from the env and run one pass.
//
// Ships DARK and fail-closed, exactly like the retention reconciler it sits beside: BILLING_MODE=off,
// an absent Stripe key, an unprovisioned webhook_billing Hyperdrive, or a key/mode mismatch → a silent
// no-op. It never throws out of the cron (a scheduled handler has no client to answer); a fault is
// logged via safeErr and swallowed so it can't wedge the shared hourly invocation.

import { createClient, drainBillingCancellations, safeErr } from "@webhook-co/db";
import {
  billingEnabled,
  makeStripeClient,
  parseBillingMode,
  readSecretBinding,
  stripeKeyMatchesMode,
} from "@webhook-co/shared";

/** The Worker bindings the drain needs — a structural subset of apps/api's Env, all optional so the
 *  cron is dark until billing is provisioned. Mirrors RetentionReconcileCronEnv. */
export interface BillingCancellationCronEnv {
  /** BILLING_MODE (off|test|live) — dark unless test/live. */
  readonly BILLING_MODE?: string;
  /** The Stripe SECRET key (sk_…) — needed to DELETE (cancel) subscriptions. */
  readonly STRIPE_SECRET_KEY?: SecretsStoreSecret;
  /** webhook_billing Hyperdrive — the cross-org read of pending jobs + column-scoped advance (0075). */
  readonly HYPERDRIVE_BILLING?: Hyperdrive;
}

/** Jobs drained per pass — a backstop far above this product's org-deletion rate. */
const DRAIN_LIMIT = 1000;
/** Attempts after which a still-failing cancellation is marked `failed` and alarmed (≈ a week of hourly
 *  retries) rather than retried forever. */
const MAX_ATTEMPTS = 168;

const log = (message: string, fields?: Record<string, unknown>): void =>
  console.log(JSON.stringify({ message, ...fields }));

/**
 * Run one Stripe-cancellation drain pass. Returns nothing — a cron has no caller; outcomes go to
 * structured logs (an ops alarm matches `billing.cancel.failed`). Guarded so an unconfigured or
 * mis-moded deployment is a clean no-op.
 */
export async function runBillingCancellationCron(env: BillingCancellationCronEnv): Promise<void> {
  const mode = parseBillingMode(env.BILLING_MODE);
  if (!billingEnabled(mode)) return; // BILLING_MODE=off → dark
  const secretKey = env.STRIPE_SECRET_KEY ? await readSecretBinding(env.STRIPE_SECRET_KEY) : null;
  if (!secretKey || secretKey.length === 0 || !env.HYPERDRIVE_BILLING) return; // unprovisioned → dark
  // Never point a live key at a test drain or vice-versa — canceling against the wrong account would
  // hit the wrong subscriptions. Mirrors makeStripeClient's own guard without throwing inside the cron.
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    log("billing.cancel.key_mode_mismatch", { mode });
    return;
  }

  const stripe = makeStripeClient({ mode, secretKey });
  const billing = createClient(env.HYPERDRIVE_BILLING.connectionString, { max: 1 });
  try {
    const result = await drainBillingCancellations({
      billing,
      canceller: { cancelSubscription: (id) => stripe.cancelSubscription(id) },
      limit: DRAIN_LIMIT,
      maxAttempts: MAX_ATTEMPTS,
      log,
    });
    log("billing.cancel.done", {
      claimed: result.claimed,
      canceled: result.canceled,
      alreadyGone: result.alreadyGone,
      retried: result.retried,
      failed: result.failed,
      capped: result.capped,
    });
  } catch (err) {
    // A Stripe or DB fault must not escape the scheduled handler. safeErr surfaces a category + Stripe's
    // structured status/type/code ONLY — never the raw message, which can carry sub_…/cus_… ids.
    log("billing.cancel.cron_failed", safeErr(err));
  } finally {
    await billing.end();
  }
}
