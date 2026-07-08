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
  /**
   * The plan's included-event cap from the price metadata (config, never in the repo). A positive integer =
   * that cap; `null` = EXPLICIT unlimited (`event_cap="unlimited"`); `undefined` = UNSPECIFIED (absent or
   * unparseable) — treated fail-CLOSED: we don't mirror any cap change, so a misconfigured price can't
   * silently grant unlimited usage (it leaves the org's existing/Free cap in place + logs).
   */
  readonly eventCap: number | null | undefined;
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

/**
 * Read the plan's event cap from a Stripe price's metadata (the number lives in Stripe config, not the repo).
 * A positive integer → that cap; the literal "unlimited" → null (EXPLICIT unlimited); anything else — absent,
 * non-string, "0"/negative, or garbage — → undefined (UNSPECIFIED). Fail-closed: undefined means "don't
 * change the cap" (never silently grant unlimited from a misconfigured/absent value).
 */
function parseCapFromPriceMetadata(metadata: unknown): number | null | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>).event_cap;
  if (typeof raw !== "string") return undefined;
  if (raw === "unlimited") return null; // explicit unlimited plan
  if (!/^\d+$/.test(raw)) return undefined; // garbage → unspecified (fail-closed)
  const n = Number(raw);
  return n > 0 ? n : undefined; // 0/negative is not a valid cap
}

/** Parse a Stripe subscription object into the mirror fields, or null if a required field is missing. */
export function parseSubscriptionObject(obj: Record<string, unknown>): ParsedSubscription | null {
  const orgId = resolveOrgId(obj);
  const id = obj.id;
  const customer = obj.customer;
  const status = obj.status;
  const firstItem = firstItemData(obj.items);
  // Period bounds: top-level (older API) OR on the item (Stripe "Basil" 2025-03-31+ moved them to items).
  const cps = pickNumber(obj.current_period_start, firstItem?.current_period_start);
  const cpe = pickNumber(obj.current_period_end, firstItem?.current_period_end);
  if (
    !orgId ||
    typeof id !== "string" ||
    typeof customer !== "string" ||
    typeof status !== "string" ||
    cps === undefined ||
    cpe === undefined
  ) {
    return null;
  }
  const price =
    firstItem && typeof firstItem.price === "object"
      ? (firstItem.price as Record<string, unknown>)
      : null;
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

function firstItemData(items: unknown): Record<string, unknown> | null {
  if (!items || typeof items !== "object") return null;
  const data = (items as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

/** The first of the candidates that is a finite number, else undefined. */
function pickNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) if (typeof c === "number" && Number.isFinite(c)) return c;
  return undefined;
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
 * watermark. Returns "stale" (and writes nothing) when a STRICTLY-NEWER event.created has already been
 * applied — the out-of-order guard. A same-second event still applies (event.created is second-granular).
 */
export async function applySubscriptionUpsert(
  billing: Sql,
  sub: ParsedSubscription,
  eventCreated: number,
): Promise<"applied" | "stale" | "customer_mismatch"> {
  const storedCap = sub.eventCap ?? null; // unspecified is stored as null in the mirror column
  return withTenant(
    billing,
    sub.orgId,
    async (tx): Promise<"applied" | "stale" | "customer_mismatch"> => {
      // Identity binding (defense-in-depth): the org is resolved from the signed metadata WE set at checkout,
      // but additionally require the subscription's Stripe CUSTOMER to match the one already linked to this org
      // (billing_customers). If the org has a recorded customer and it differs, refuse to mutate — a Stripe
      // subscription never changes customer, so a mismatch is a bug/attack, not a legitimate update. When no
      // customer is linked yet (the checkout event may not have landed), we can't cross-check, so we proceed.
      const [linked] = await tx<{ stripe_customer_id: string }[]>`
        select stripe_customer_id from billing_customers`;
      if (linked && linked.stripe_customer_id !== sub.customerId) return "customer_mismatch";

      // Atomic watermark guard: the `where … <= excluded.last` on the conflict-update makes the stale check
      // and the write ONE statement (the row lock serializes concurrent same-org events, and the re-check runs
      // under the lock), so a strictly-older event can never overwrite a newer one — no read/write TOCTOU. A
      // same-second (==) event still applies (last-write-wins) since event.created is only second-granular.
      const applied = await tx<{ org_id: string }[]>`
      insert into billing_subscriptions
        (org_id, stripe_subscription_id, plan, status, event_cap,
         current_period_start, current_period_end, cancel_at_period_end, last_stripe_event_created)
      values
        (${sub.orgId}, ${sub.stripeSubscriptionId}, ${sub.plan}, ${sub.status}, ${storedCap},
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
        updated_at = now()
      where billing_subscriptions.last_stripe_event_created <= excluded.last_stripe_event_created
      returning org_id`;
      if (applied.length === 0) return "stale"; // a strictly-newer event already applied

      // Cap mirror — increase-now/decrease-defer — ONLY for a specified cap. Unspecified (undefined) is
      // fail-closed: leave the existing/Free cap untouched rather than grant unlimited from a bad price config.
      if (sub.eventCap === undefined) return "applied";
      const [limit] = await tx<{ event_cap: string | null }[]>`select event_cap from org_limits`;
      const current = limit
        ? limit.event_cap === null
          ? null
          : Number(limit.event_cap)
        : undefined;
      const decision = capMirrorDecision(current, sub.eventCap);
      if (decision.apply) {
        await tx`
        insert into org_limits (org_id, event_cap) values (${sub.orgId}, ${decision.value})
        on conflict (org_id) do update set event_cap = ${decision.value}`;
      }
      return "applied";
    },
  );
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
    // Atomic watermark guard on the UPDATE (same reasoning as the upsert). A row is returned only when the
    // downgrade actually applied (stored watermark ≤ this event); then remove the paid cap mirror.
    const applied = await tx<{ org_id: string }[]>`
      update billing_subscriptions
      set status = 'canceled', last_stripe_event_created = ${args.eventCreated}, updated_at = now()
      where last_stripe_event_created <= ${args.eventCreated}
      returning org_id`;
    if (applied.length > 0) {
      await tx`delete from org_limits`; // back to the injected Free default
      return "applied";
    }
    // No row updated: either there is no subscription (nothing to downgrade → idempotent "applied"), or a
    // strictly-newer event already advanced the watermark past this one ("stale").
    const [exists] = await tx<{ x: number }[]>`select 1 as x from billing_subscriptions`;
    return exists ? "stale" : "applied";
  });
}
