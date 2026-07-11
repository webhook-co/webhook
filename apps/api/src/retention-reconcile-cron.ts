// S2b retention reconciler cron shell. The pure reconcile logic lives in @webhook-co/db
// (reconcileRetentionFromStripe); this is the thin workerd wiring: build the Stripe client + the
// webhook_billing connection from the Worker env, run the pass, and log a PII-free summary.
//
// Ships DARK and fail-closed, exactly like the tail-flush runner it mirrors: BILLING_MODE=off, an absent
// Stripe key, an unprovisioned webhook_billing Hyperdrive, or a key/mode mismatch → a silent no-op. It never
// throws out of the cron (a scheduled handler has no client to return an error to); a fault is logged and
// swallowed so it can't wedge the shared hourly invocation.

import {
  createClient,
  reconcileRetentionFromStripe,
  safeErr,
  type StripeSubscriptionLister,
} from "@webhook-co/db";
import {
  billingEnabled,
  makeStripeClient,
  parseBillingMode,
  readSecretBinding,
  stripeKeyMatchesMode,
} from "@webhook-co/shared";

/** The Worker bindings the reconciler needs — a structural subset of apps/api's Env, all optional so the
 *  cron is dark until billing is provisioned. */
export interface RetentionReconcileCronEnv {
  /** BILLING_MODE (off|test|live) — dark unless test/live. */
  readonly BILLING_MODE?: string;
  /** The Stripe SECRET key (sk_…) — needed to LIST subscriptions (the plan→retention source of truth). */
  readonly STRIPE_SECRET_KEY?: SecretsStoreSecret;
  /** webhook_billing Hyperdrive — the per-org read+repair connection (0054 grants it update(retention_days)). */
  readonly HYPERDRIVE_BILLING?: Hyperdrive;
}

/** Bound on repairs/alarms surfaced per pass — a backstop, far above this product's subscription count. */
const RECONCILE_LIMIT = 1000;

const log = (message: string, fields?: Record<string, unknown>): void =>
  console.log(JSON.stringify({ message, ...fields }));

/**
 * Run one retention-reconcile pass. Returns nothing — a cron has no caller to answer; outcomes go to
 * structured logs (an ops alarm matches on `billing.retention_reconcile.repaired` / `.over_retained` /
 * `.unparseable_subscription`). Guarded so an unconfigured or mis-moded deployment is a clean no-op.
 */
export async function runRetentionReconcileCron(env: RetentionReconcileCronEnv): Promise<void> {
  const mode = parseBillingMode(env.BILLING_MODE);
  if (!billingEnabled(mode)) return; // BILLING_MODE=off → dark
  const secretKey = env.STRIPE_SECRET_KEY ? await readSecretBinding(env.STRIPE_SECRET_KEY) : null;
  if (!secretKey || secretKey.length === 0 || !env.HYPERDRIVE_BILLING) return; // unprovisioned → dark
  // Never point a live key at a test pass or vice-versa — reconciling against the wrong account could write
  // a wrong window. Mirrors makeStripeClient's own guard without throwing inside the cron.
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    log("billing.retention_reconcile.key_mode_mismatch", { mode });
    return;
  }

  const stripe = makeStripeClient({ mode, secretKey });
  const reader: StripeSubscriptionLister = { listSubscriptions: () => stripe.listSubscriptions() };
  const billing = createClient(env.HYPERDRIVE_BILLING.connectionString, { max: 1 });
  try {
    const result = await reconcileRetentionFromStripe({
      billing,
      reader,
      limit: RECONCILE_LIMIT,
      log,
    });
    log("billing.retention_reconcile.done", {
      subsSeen: result.subsSeen,
      entitledChecked: result.entitledChecked,
      repaired: result.repaired.length,
      overRetained: result.overRetained.length,
      unparseable: result.unparseable,
      capped: result.capped,
    });
  } catch (err) {
    // A Stripe list failure or a DB fault must not escape the scheduled handler. safeErr (the same helper the
    // sibling reconcilers use) surfaces a category + Stripe's structured status/type/code ONLY — never the
    // raw message, which can carry cus_…/sub_… ids or PG row detail.
    log("billing.retention_reconcile.cron_failed", safeErr(err));
  } finally {
    await billing.end();
  }
}
