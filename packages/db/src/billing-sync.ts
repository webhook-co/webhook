// S4.5b Stripe inbound state-sync. Applies VERIFIED Stripe events to the billing tables (the receiver in
// apps/api verifies + dedups first, then dispatches here). Everything runs UNDER the resolved org's RLS
// context (withTenant, org from the SIGNED metadata WE set at checkout) as webhook_billing, so a write can
// only ever touch that one org. A monotonic event.created watermark makes out-of-order Stripe deliveries
// idempotent per subscription. Cap changes are increase-NOW / decrease-DEFER (never instant-pause a paying
// customer — a decrease is applied at the period boundary by S4.5b-2's invoice.paid handler).

import { withTenant, type Sql } from "./client";

/** A Stripe subscription object parsed into the fields we mirror. */
export interface ParsedSubscription {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
  readonly customerId: string;
  readonly plan: string;
  readonly status: string;
  /** The plan's included-event cap (from the price's metadata — config, never in the repo). null = unlimited. */
  readonly eventCap: number | null;
  readonly currentPeriodStartIso: string;
  readonly currentPeriodEndIso: string;
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Resolve OUR org id from a Stripe object: `client_reference_id` (Checkout) or `metadata.org_id`
 * (subscription) — the SIGNED value we stamped, never email. Returns null if neither is present.
 */
export function resolveOrgId(obj: Record<string, unknown>): string | null {
  const cri = obj.client_reference_id;
  if (typeof cri === "string" && cri.length > 0) return cri;
  const md = obj.metadata;
  if (md && typeof md === "object") {
    const org = (md as Record<string, unknown>).org_id;
    if (typeof org === "string" && org.length > 0) return org;
  }
  return null;
}

/** Parse a checkout.session.completed object → the org↔customer link, or null if it can't be resolved. */
export function parseCheckoutSession(
  obj: Record<string, unknown>,
): { orgId: string; customerId: string } | null {
  const orgId = resolveOrgId(obj);
  const customer = obj.customer;
  if (!orgId || typeof customer !== "string" || customer.length === 0) return null;
  return { orgId, customerId: customer };
}

/** Read the plan's event cap from a Stripe price's metadata. A positive integer → the cap; anything else
 *  (absent / "unlimited" / non-numeric) → null (unlimited). The number lives in Stripe config, not the repo. */
function parseCapFromPriceMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).event_cap;
  if (typeof raw !== "string") return null;
  if (!/^\d+$/.test(raw)) return null; // strict: only a clean non-negative integer
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Parse a Stripe subscription object into the mirror fields, or null if a required field is missing. */
export function parseSubscriptionObject(obj: Record<string, unknown>): ParsedSubscription | null {
  const orgId = resolveOrgId(obj);
  const id = obj.id;
  const customer = obj.customer;
  const status = obj.status;
  const cps = obj.current_period_start;
  const cpe = obj.current_period_end;
  if (
    !orgId ||
    typeof id !== "string" ||
    typeof customer !== "string" ||
    typeof status !== "string" ||
    typeof cps !== "number" ||
    typeof cpe !== "number"
  ) {
    return null;
  }
  const price = firstItemPrice(obj.items);
  return {
    orgId,
    stripeSubscriptionId: id,
    customerId: customer,
    plan: price && typeof price.id === "string" ? price.id : "",
    status,
    eventCap: parseCapFromPriceMetadata(price?.metadata),
    currentPeriodStartIso: new Date(cps * 1000).toISOString(),
    currentPeriodEndIso: new Date(cpe * 1000).toISOString(),
    cancelAtPeriodEnd: obj.cancel_at_period_end === true,
  };
}

function firstItemPrice(items: unknown): Record<string, unknown> | null {
  if (!items || typeof items !== "object") return null;
  const data = (items as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  const price = (first as Record<string, unknown>).price;
  return price && typeof price === "object" ? (price as Record<string, unknown>) : null;
}

/**
 * Decide how to mirror a plan's cap into org_limits — increase-NOW, decrease-DEFER. `current` is the org's
 * existing org_limits.event_cap (undefined = no row yet, null = unlimited); `next` is the plan's cap (null =
 * unlimited). Returns whether to write and the value. A decrease is NOT applied here (leaving the more
 * generous cap in place until the period boundary) so a mid-period downgrade never instant-pauses a payer.
 */
export function capMirrorDecision(
  current: number | null | undefined,
  next: number | null,
): { apply: boolean; value: number | null } {
  if (current === undefined) return { apply: true, value: next }; // new paid org — establish the cap
  if (next === null)
    return current === null ? { apply: false, value: null } : { apply: true, value: null }; // → unlimited is an increase
  if (current === null) return { apply: false, value: current }; // unlimited → capped is a decrease → defer
  if (next > current) return { apply: true, value: next }; // higher cap → increase now
  return { apply: false, value: current }; // lower or equal → defer / no-op
}

/** Link an org to its Stripe customer (checkout.session.completed). Idempotent upsert on the org PK. */
export async function applyCustomerLink(
  billing: Sql,
  args: { orgId: string; customerId: string },
): Promise<void> {
  await withTenant(
    billing,
    args.orgId,
    (tx) => tx`
      insert into billing_customers (org_id, stripe_customer_id)
      values (${args.orgId}, ${args.customerId})
      on conflict (org_id) do update set stripe_customer_id = excluded.stripe_customer_id`,
  );
}

/**
 * Upsert the subscription mirror + mirror the cap into org_limits (increase-now), guarded by the event
 * watermark. Returns "stale" (and writes nothing) when an older-or-equal event.created has already been
 * applied — the out-of-order guard.
 */
export async function applySubscriptionUpsert(
  billing: Sql,
  sub: ParsedSubscription,
  eventCreated: number,
): Promise<"applied" | "stale"> {
  return withTenant(billing, sub.orgId, async (tx): Promise<"applied" | "stale"> => {
    const [existing] = await tx<{ last: string }[]>`
      select last_stripe_event_created::text as last from billing_subscriptions`;
    if (existing && Number(existing.last) >= eventCreated) return "stale";

    await tx`
      insert into billing_subscriptions
        (org_id, stripe_subscription_id, plan, status, event_cap,
         current_period_start, current_period_end, cancel_at_period_end, last_stripe_event_created)
      values
        (${sub.orgId}, ${sub.stripeSubscriptionId}, ${sub.plan}, ${sub.status}, ${sub.eventCap},
         ${sub.currentPeriodStartIso}, ${sub.currentPeriodEndIso}, ${sub.cancelAtPeriodEnd}, ${eventCreated})
      on conflict (org_id) do update set
        stripe_subscription_id = excluded.stripe_subscription_id,
        plan = excluded.plan,
        status = excluded.status,
        event_cap = excluded.event_cap,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        last_stripe_event_created = excluded.last_stripe_event_created,
        updated_at = now()`;

    const [limit] = await tx<{ event_cap: string | null }[]>`select event_cap from org_limits`;
    const current = limit ? (limit.event_cap === null ? null : Number(limit.event_cap)) : undefined;
    const decision = capMirrorDecision(current, sub.eventCap);
    if (decision.apply) {
      await tx`
        insert into org_limits (org_id, event_cap) values (${sub.orgId}, ${decision.value})
        on conflict (org_id) do update set event_cap = ${decision.value}`;
    }
    return "applied";
  });
}

/**
 * Downgrade an org to Free on subscription.deleted (watermark-guarded): mark the subscription canceled and
 * REMOVE the paid cap mirror, so the soft-cap producer falls back to the injected Free default. Idempotent.
 */
export async function applySubscriptionDeleted(
  billing: Sql,
  args: { orgId: string; eventCreated: number },
): Promise<"applied" | "stale"> {
  return withTenant(billing, args.orgId, async (tx): Promise<"applied" | "stale"> => {
    const [existing] = await tx<{ last: string }[]>`
      select last_stripe_event_created::text as last from billing_subscriptions`;
    if (!existing) return "applied"; // no subscription → nothing to downgrade
    if (Number(existing.last) >= args.eventCreated) return "stale";
    await tx`
      update billing_subscriptions
      set status = 'canceled', last_stripe_event_created = ${args.eventCreated}, updated_at = now()`;
    await tx`delete from org_limits`; // remove the paid cap → back to the Free default
    return "applied";
  });
}
