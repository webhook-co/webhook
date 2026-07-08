import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { recordStripeEventOnce } from "../src/stripe-events";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The Stripe inbound dedup ledger (S4.5a): insert-wins idempotency under the webhook_billing role, on the
// GLOBAL processed_stripe_events table (no tenant context). First sighting wins; every redelivery is a no-op.

let pg: EphemeralPostgres;
let billing: Sql; // the webhook_billing writer role
let admin: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  billing = createClient(pg.urlFor({ role: DB_ROLES.billing }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from processed_stripe_events`;
});

afterAll(async () => {
  await billing?.end();
  await admin?.end();
  await pg?.stop();
});

describe("recordStripeEventOnce", () => {
  it("returns true the FIRST time an event id is seen, false on every redelivery", async () => {
    const ev = {
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      eventCreated: 1752000000,
    };
    expect(await recordStripeEventOnce(billing, ev)).toBe(true);
    expect(await recordStripeEventOnce(billing, ev)).toBe(false);
    expect(await recordStripeEventOnce(billing, ev)).toBe(false);
  });

  it("treats distinct event ids independently", async () => {
    expect(
      await recordStripeEventOnce(billing, { eventId: "evt_a", eventType: "x", eventCreated: 1 }),
    ).toBe(true);
    expect(
      await recordStripeEventOnce(billing, { eventId: "evt_b", eventType: "x", eventCreated: 2 }),
    ).toBe(true);
    // A redelivery of evt_a is still a no-op even after evt_b landed.
    expect(
      await recordStripeEventOnce(billing, { eventId: "evt_a", eventType: "x", eventCreated: 1 }),
    ).toBe(false);
  });

  it("persists the recorded row (type + created watermark) for the winner", async () => {
    await recordStripeEventOnce(billing, {
      eventId: "evt_row",
      eventType: "customer.subscription.updated",
      eventCreated: 1752537600,
    });
    const [row] = await billing<{ event_type: string; event_created: string }[]>`
      select event_type, event_created::text as event_created
      from processed_stripe_events where event_id = ${"evt_row"}`;
    expect(row.event_type).toBe("customer.subscription.updated");
    expect(row.event_created).toBe("1752537600");
  });

  it("records exactly once when two deliveries of the SAME event race concurrently", async () => {
    // The load-bearing at-least-once guarantee: two overlapping Stripe redeliveries hit the insert at the
    // same time; the ON CONFLICT DO NOTHING must let exactly ONE win (fresh=true) and leave a single row.
    // (Sequential can't prove this — the loser must observe the winner's row, not double-insert.) Two
    // SEPARATE connections make it a genuine parallel race, not same-connection pipelining.
    const b1 = createClient(pg.urlFor({ role: DB_ROLES.billing }));
    const b2 = createClient(pg.urlFor({ role: DB_ROLES.billing }));
    try {
      const ev = { eventId: "evt_race", eventType: "invoice.paid", eventCreated: 42 };
      const [a, b] = await Promise.all([
        recordStripeEventOnce(b1, ev),
        recordStripeEventOnce(b2, ev),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one claimant
      const [{ n }] = await billing<{ n: number }[]>`
        select count(*)::int as n from processed_stripe_events where event_id = ${"evt_race"}`;
      expect(n).toBe(1); // and a single durable row
    } finally {
      await Promise.all([b1.end(), b2.end()]);
    }
  });
});
