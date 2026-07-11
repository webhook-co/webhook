// S2b retention reconciler. A defense-in-depth guard against the catastrophe this whole lane exists to
// prevent: a paying customer's retention window stuck too LOW while their plan entitles more, so the hourly
// prune irreversibly deletes their events + R2 bodies on day 8.
//
// S2a made the unparseable-subscription bug REPAIRABLE (return "rejected", not a permanent dedup marker) and
// logged it once at receipt. This closes the loop: an hourly pass that AUTO-REPAIRS a stuck-low window and
// ALARMS on anything it deliberately won't touch — so the guarantee no longer depends on a human noticing a
// one-time log line before day 8.
//
// Stripe is the source of truth: the plan → retention mapping lives in price metadata, and enumerating
// active subscriptions FROM Stripe (not the DB) means we also catch an org whose subscription never mirrored
// at all (no billing_subscriptions row) — a DB-only reconcile is blind to those, and they are exactly the
// unparseable-then-rejected case.
//
// THE ONE SAFETY RULE — repair only in the LENGTHENING direction. Shrinking a window deletes data, the very
// harm we guard against, so a bug here must never be able to cause it. An org with MORE retention than its
// plan entitles (over-retention) is the SAFE miss: it only costs storage. We ALARM on it and never
// auto-shrink; a human decides. This mirrors the parser's own asymmetry (billing-sync
// parseRetentionFromPriceMetadata) and the whole lane's thesis: premature deletion is unrecoverable.
//
// Runs per-org as webhook_billing (via withTenant), reusing the grants it already has (0054: select +
// update(retention_days) on orgs; 0048: read its own billing_subscriptions). No cross-org role, no new
// schema — the org id comes from each subscription's SIGNED metadata (the org_id WE set at checkout).

import { isBillingActive } from "@webhook-co/shared";

import { parseSubscriptionObject } from "./billing-sync";
import { withTenant, type Sql } from "./client";

/**
 * Lists the account's non-canceled subscriptions as raw Stripe objects (the production adapter paginates
 * `GET /v1/subscriptions`, whose default already excludes canceled). Injected so the reconcile logic is
 * testable against ephemeral Postgres without a network. Raw objects (not parsed) so the reconciler applies
 * the SAME parseSubscriptionObject the inbound webhook uses — one definition of "what this subscription
 * entitles", never a second that could drift.
 */
export interface StripeSubscriptionLister {
  listSubscriptions(): Promise<Record<string, unknown>[]>;
}

export interface RetentionReconcileDeps {
  /** webhook_billing connection — per-org read + repair under withTenant. */
  readonly billing: Sql;
  /** The Stripe subscription-list seam. */
  readonly reader: StripeSubscriptionLister;
  /** Max repairs/alarms surfaced per pass (`capped` flags truncation). */
  readonly limit: number;
  /** Optional structured logger; only non-PII fields (org id, windows) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** One org whose window this pass changed (repaired) or flagged (over-retained). */
export interface RetentionChange {
  readonly orgId: string;
  /** The org's window before this pass. */
  readonly from: number | null;
  /** The window the plan entitles (what we repaired TO, or what over-retention was measured against). */
  readonly to: number | null;
}

export interface RetentionReconcileResult {
  /** Non-canceled subscriptions returned by Stripe. */
  readonly subsSeen: number;
  /** Parseable AND entitled (active/trialing/past_due) subscriptions actually reconciled. */
  readonly entitledChecked: number;
  /** Orgs whose window was lengthened to match their plan (the auto-repair). */
  readonly repaired: readonly RetentionChange[];
  /** Orgs whose window is MORE generous than their plan — alarmed, never auto-shrunk. */
  readonly overRetained: readonly RetentionChange[];
  /** Subscriptions Stripe returned that our parser couldn't read — alarmed; the parser needs updating. */
  readonly unparseable: number;
  /** True when a surfaced list hit `limit` (truncated) — widen the pass. */
  readonly capped: boolean;
}

/**
 * Is window `a` MORE RESTRICTIVE than `b` — i.e. would it delete data that `b` keeps? `null` = unlimited =
 * the least restrictive window of all (it never deletes). A smaller finite window is more restrictive than a
 * larger one. This is the single predicate the safe-direction rule turns on: we auto-repair a window UP
 * (current more restrictive than entitled) and only ever alarm on the reverse.
 */
export function isMoreRestrictiveWindow(a: number | null, b: number | null): boolean {
  if (a === b) return false;
  if (a === null) return false; // unlimited never deletes → never more restrictive
  if (b === null) return true; // a is finite, b is unlimited → a deletes, b doesn't
  return a < b;
}

export async function reconcileRetentionFromStripe(
  deps: RetentionReconcileDeps,
): Promise<RetentionReconcileResult> {
  const subs = await deps.reader.listSubscriptions();
  const repaired: RetentionChange[] = [];
  const overRetained: RetentionChange[] = [];
  let entitledChecked = 0;
  let unparseable = 0;

  for (const raw of subs) {
    const parsed = parseSubscriptionObject(raw);
    if (!parsed) {
      // We can't derive what this subscription entitles, so we CANNOT safely repair — but a spike here is
      // the signal that Stripe changed a subscription shape and the parser must be updated before day-8
      // pruning bites the orgs behind these subscriptions. PII-free: message only, no ids.
      unparseable += 1;
      deps.log?.("billing.retention_reconcile.unparseable_subscription", {});
      continue;
    }
    // Only entitled subscriptions carry a paid window. incomplete/unpaid/paused are not paying customers;
    // their window is (correctly) the Free one, handled by the downgrade path — never touch them here.
    if (!isBillingActive(parsed.status)) continue;
    entitledChecked += 1;

    const change = await withTenant(
      deps.billing,
      parsed.orgId,
      async (tx): Promise<{ kind: "repaired" | "over" | "noop"; from: number | null } | null> => {
        const [org] = await tx<{ retention_days: number | null }[]>`
        select retention_days from orgs where id = ${parsed.orgId}`;
        if (!org) return null; // no such org (deleted) — nothing to reconcile
        const current = org.retention_days;
        const entitled = parsed.retentionDays;
        if (current === entitled) return { kind: "noop", from: current };
        if (isMoreRestrictiveWindow(current, entitled)) {
          // The org would delete data its plan says to keep — repair UP. This is the safe, load-bearing write.
          await tx`update orgs set retention_days = ${entitled} where id = ${parsed.orgId}`;
          return { kind: "repaired", from: current };
        }
        // current is LESS restrictive than entitled → over-retention. Never auto-shrink (that deletes data).
        return { kind: "over", from: current };
      },
    );

    if (!change || change.kind === "noop") continue;
    const rec: RetentionChange = {
      orgId: parsed.orgId,
      from: change.from,
      to: parsed.retentionDays,
    };
    if (change.kind === "repaired") {
      if (repaired.length < deps.limit) {
        deps.log?.("billing.retention_reconcile.repaired", {
          orgId: rec.orgId,
          from: rec.from,
          to: rec.to,
        });
      }
      repaired.push(rec);
    } else {
      if (overRetained.length < deps.limit) {
        deps.log?.("billing.retention_reconcile.over_retained", {
          orgId: rec.orgId,
          from: rec.from,
          to: rec.to,
        });
      }
      overRetained.push(rec);
    }
  }

  const capped = repaired.length > deps.limit || overRetained.length > deps.limit;
  return {
    subsSeen: subs.length,
    entitledChecked,
    repaired: repaired.slice(0, deps.limit),
    overRetained: overRetained.slice(0, deps.limit),
    unparseable,
    capped,
  };
}
