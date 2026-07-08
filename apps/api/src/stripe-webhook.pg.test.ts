import { randomUUID } from "node:crypto";

import { createClient, DB_ROLES, withTenant, type Sql } from "@webhook-co/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setupSchema } from "../../../packages/db/test/migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "../../../packages/db/test/pg";
import { processStripeEvent, type StripeEvent } from "./stripe-webhook.js";

// The processStripeEvent orchestration (seen-check → APPLY → record-dedup) against a REAL Postgres with the
// real appliers under RLS as webhook_billing. Proves the correctness-critical contract: a fresh event
// applies + records; a replay short-circuits without re-applying; an apply FAILURE records NOTHING so the
// event can be safely redelivered (no silent loss); an unhandled type is still recorded.

let pg: EphemeralPostgres;
let app: Sql; // seeds orgs
let billing: Sql; // the webhook_billing writer (what processStripeEvent runs as)
let admin: Sql;

function ev(
  type: string,
  object: Record<string, unknown>,
  id = "evt_" + randomUUID(),
): StripeEvent {
  return { id, type, created: 1_000_000, livemode: false, data: { object } };
}

function subObject(orgId: string, cap = "500000"): Record<string, unknown> {
  return {
    id: "sub_" + orgId.slice(0, 6),
    customer: "cus_" + orgId.slice(0, 6),
    status: "active",
    metadata: { org_id: orgId },
    current_period_start: Math.floor(Date.UTC(2026, 6, 1) / 1000),
    current_period_end: Math.floor(Date.UTC(2026, 7, 1) / 1000),
    items: { data: [{ price: { id: "price_pro", metadata: { event_cap: cap } } }] },
  };
}

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}
async function ledgerCount(eventId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from processed_stripe_events where event_id = ${eventId}`;
  return row.n;
}
async function customerOf(orgId: string): Promise<string | undefined> {
  const [row] = await admin<{ stripe_customer_id: string }[]>`
    select stripe_customer_id from billing_customers where org_id = ${orgId}`;
  return row?.stripe_customer_id;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  billing = createClient(pg.urlFor({ role: DB_ROLES.billing }));
  admin = createClient(pg.ownerUrl);
});

afterEach(async () => {
  await admin`delete from processed_stripe_events`;
  await admin`delete from org_limits`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from billing_customers`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await billing?.end();
  await admin?.end();
  await pg?.stop();
});

describe("processStripeEvent (integration)", () => {
  it("a fresh event APPLIES the state change AND records the dedup marker", async () => {
    const org = await seedOrg();
    const e = ev("checkout.session.completed", { client_reference_id: org, customer: "cus_X" });
    expect(await processStripeEvent(billing, e)).toBe("applied");
    expect(await customerOf(org)).toBe("cus_X"); // applier ran
    expect(await ledgerCount(e.id)).toBe(1); // dedup recorded
  });

  it("a REPLAY short-circuits — no re-apply, still one ledger row", async () => {
    const org = await seedOrg();
    const e = ev("checkout.session.completed", { client_reference_id: org, customer: "cus_first" });
    await processStripeEvent(billing, e);
    // The SAME event id redelivered with different data must NOT re-apply (dedup short-circuits).
    const e2: StripeEvent = {
      ...e,
      data: { object: { client_reference_id: org, customer: "cus_SECOND" } },
    };
    expect(await processStripeEvent(billing, e2)).toBe("replay");
    expect(await customerOf(org)).toBe("cus_first"); // unchanged — the replay never re-applied
    expect(await ledgerCount(e.id)).toBe(1);
  });

  it("an unhandled type is a no-op APPLY but is still recorded (deduped)", async () => {
    const e = ev("invoice.paid", { id: "in_1" });
    expect(await processStripeEvent(billing, e)).toBe("applied");
    expect(await ledgerCount(e.id)).toBe(1);
  });

  it("a customer_mismatch is REJECTED, NOT deduped, and reprocessable after the data is corrected", async () => {
    const org = await seedOrg();
    // Link the org to cus_A, then send a subscription event carrying a DIFFERENT customer (cus_B).
    await processStripeEvent(
      billing,
      ev("checkout.session.completed", { client_reference_id: org, customer: "cus_A" }),
    );
    const bad = ev("customer.subscription.created", {
      ...subObject(org),
      customer: "cus_B", // ≠ the linked cus_A
    });
    expect(await processStripeEvent(billing, bad)).toBe("rejected");
    expect(await ledgerCount(bad.id)).toBe(0); // NOT deduped → a later fix + replay can reprocess
    const [noSub] = await admin<{ n: number }[]>`
      select count(*)::int as n from billing_subscriptions where org_id = ${org}`;
    expect(noSub.n).toBe(0); // never mutated on a mismatch

    // Correct the underlying data (re-link to cus_B), then the SAME event replays cleanly (it wasn't deduped).
    await processStripeEvent(
      billing,
      ev("checkout.session.completed", { client_reference_id: org, customer: "cus_B" }),
    );
    expect(await processStripeEvent(billing, bad)).toBe("applied");
    expect(await ledgerCount(bad.id)).toBe(1);
  });

  it("MONEY-SAFETY: an apply FAILURE records NO ledger row, so a redelivery re-applies (no loss)", async () => {
    // A subscription event for an org that doesn't exist yet → the applier's FK insert throws. Because the
    // dedup marker is written only AFTER a successful apply, NOTHING is recorded — Stripe would 500 + retry.
    const org = randomUUID(); // NOT seeded
    const e = ev("customer.subscription.created", subObject(org));
    await expect(processStripeEvent(billing, e)).rejects.toThrow();
    expect(await ledgerCount(e.id)).toBe(0); // not marked processed → safe to redeliver

    // The redelivery (now the org exists — the transient condition cleared) applies cleanly.
    await withTenant(app, org, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${org}, ${org.slice(0, 8)}, ${"o"})`;
    });
    expect(await processStripeEvent(billing, e)).toBe("applied");
    expect(await ledgerCount(e.id)).toBe(1);
    const [sub] = await admin<{ status: string }[]>`
      select status from billing_subscriptions where org_id = ${org}`;
    expect(sub.status).toBe("active");
  });
});
