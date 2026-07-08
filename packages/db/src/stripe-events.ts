// S4.5 Stripe inbound webhook — the replay-dedup ledger seam. Runs as the webhook_billing role against the
// GLOBAL processed_stripe_events table (no tenant context — a Stripe event isn't org-scoped until the
// handler resolves org from signed metadata). The insert-wins is the idempotency gate: it MUST be the first
// write after the signature verifies, before any state mutation, so an at-least-once redelivery is a no-op.

import type { Sql } from "./client";

export interface StripeEventRecord {
  /** Stripe's public event id (evt_…) — the globally-unique idempotency key. */
  readonly eventId: string;
  readonly eventType: string;
  /** Stripe's event.created (unix seconds) — the out-of-order watermark source. */
  readonly eventCreated: number;
}

/**
 * Record a Stripe event id in the dedup ledger. Returns TRUE the first time this event is seen (the caller
 * should process it) and FALSE on any redelivery (ACK 200, no side effects). `on conflict do nothing` makes
 * the gate atomic — two concurrent deliveries of the same event race the insert, and exactly one wins.
 */
export async function recordStripeEventOnce(sql: Sql, ev: StripeEventRecord): Promise<boolean> {
  const rows = await sql<{ event_id: string }[]>`
    insert into processed_stripe_events (event_id, event_type, event_created)
    values (${ev.eventId}, ${ev.eventType}, ${ev.eventCreated})
    on conflict (event_id) do nothing
    returning event_id`;
  return rows.length > 0;
}
