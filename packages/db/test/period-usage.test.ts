import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { effectiveBillingPeriod, sumPeriodEventUsage } from "../src/period-usage";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// effectiveBillingPeriod (S4.5b-2): a PAID org's Stripe-anchored cycle (billing_subscriptions period) when
// it has a non-canceled subscription, else the UTC calendar month. The ONE period basis both the soft-cap
// and the usage surface use, so a paid org is metered over its real cycle, not the wrong UTC month.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → UTC month [2026-07-01, 2026-08-01)

let pg: EphemeralPostgres;
let app: Sql;
let admin: Sql; // seeds SELECT-only billing_subscriptions

/** Seed an org. `createdAt` anchors the Free tier's LIFETIME allowance window — default it well before any
 *  seeded usage (in prod an org's events can never predate it; the DB default `now()` is the real clock,
 *  which sits after these fixtures' fake dates). */
const ORG_CREATED = "2026-01-01T00:00:00.000Z";
async function seedOrg(createdAt = ORG_CREATED): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at)
             values (${orgId}, ${orgId.slice(0, 8)}, ${"o"}, ${createdAt})`;
  });
  return orgId;
}

async function seedUsage(orgId: string, windowIso: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${windowIso}, ${count})`;
  });
}

/** Seed a single raw event with an exact received_at (trigger-stamped on INSERT, then set). */
async function seedEventAt(orgId: string, receivedAtIso: string): Promise<void> {
  const endpointId = randomUUID();
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${id}, ${orgId}, ${endpointId}, ${"k" + id}, ${10}, ${"d" + id}, ${"content_hash"})`;
    await tx`update events set received_at = ${receivedAtIso} where id = ${id}`;
  });
}

async function seedSubscription(
  orgId: string,
  opts: { status?: string; start: string; end: string },
) {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 6)}, ${"pro"}, ${opts.status ?? "active"},
            ${opts.start}, ${opts.end})`;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from events`;
  await admin`delete from usage`;
  await admin`delete from endpoints`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await pg?.stop();
});

describe("effectiveBillingPeriod", () => {
  it("is the ONE-TIME LIFETIME allowance when the org has NO subscription (Free)", async () => {
    const org = await seedOrg();
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    // Anchored at org creation, open-ended: a one-time allowance never resets.
    expect(period).toEqual({ start: ORG_CREATED, end: null, kind: "lifetime" });
  });

  it("uses the SUBSCRIPTION's Stripe cycle, flooring the start to UTC midnight (day-bucket aligned)", async () => {
    const org = await seedOrg();
    // A signup-anchored cycle with a NON-midnight start that straddles the UTC-month boundary. The start is
    // floored to midnight (so the UTC-day `usage` bucket for that day is included, no start-day undercount);
    // the end stays the raw instant (it only bounds the instant-precise live half).
    await seedSubscription(org, { start: "2026-06-18T14:30:00Z", end: "2026-07-18T09:00:00Z" });
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period).toEqual({
      start: "2026-06-18T00:00:00.000Z", // floored to midnight
      end: "2026-07-18T09:00:00.000Z", // raw instant
      kind: "billing_cycle",
    });
  });

  it("falls back to the UTC month when the Stripe cycle has LAPSED (never to lifetime — a payer must not be stranded)", async () => {
    const org = await seedOrg();
    // A cycle that ended BEFORE now (a late/missing renewal webhook) must not anchor — and must NOT fall to
    // the lifetime window either, or the payer's lifetime usage would instantly exceed any cap.
    await seedSubscription(org, { start: "2026-06-05T00:00:00Z", end: "2026-07-05T00:00:00Z" }); // end < NOW
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period).toEqual({
      start: "2026-07-01T00:00:00.000Z", // UTC month fallback
      end: "2026-08-01T00:00:00.000Z",
      kind: "billing_cycle",
    });
  });

  it("a CANCELED subscription falls back to the LIFETIME allowance (churn → allowance already spent)", async () => {
    const org = await seedOrg();
    await seedSubscription(org, {
      status: "canceled",
      start: "2026-06-18T00:00:00Z",
      end: "2026-07-18T00:00:00Z",
    });
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period).toEqual({ start: ORG_CREATED, end: null, kind: "lifetime" });
  });

  it("is RLS-scoped — org A's period never reflects org B's subscription", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await seedSubscription(b, { start: "2026-06-18T00:00:00Z", end: "2026-07-18T00:00:00Z" });
    // A has no subscription → its own lifetime allowance, unaffected by B's cycle.
    const period = await withTenant(app, a, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period).toEqual({ start: ORG_CREATED, end: null, kind: "lifetime" });
  });

  it("anchors the lifetime window at THIS org's creation instant", async () => {
    const org = await seedOrg("2026-03-07T08:15:00.000Z");
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period.start).toBe("2026-03-07T08:15:00.000Z");
    expect(period.end).toBeNull();
  });
});

describe("sumPeriodEventUsage — the LIFETIME (open-ended) window", () => {
  it("counts EVERY event ever, across months, with no upper bound", async () => {
    const org = await seedOrg(); // created 2026-01-01
    await seedUsage(org, "2026-02-10T00:00:00.000Z", 40); // months before "this" month
    await seedUsage(org, "2026-06-30T00:00:00.000Z", 60); // prior month
    await seedUsage(org, "2026-07-02T00:00:00.000Z", 100); // this month, rolled
    await seedEventAt(org, "2026-07-15T06:00:00.000Z"); // today, live
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    const total = await withTenant(app, org, (tx) => sumPeriodEventUsage(tx, period, NOW));
    expect(total).toBe(201); // 40 + 60 + 100 rolled + 1 live — a one-time allowance spans all time
  });

  it("excludes usage that predates the org's creation anchor", async () => {
    const org = await seedOrg("2026-06-01T00:00:00.000Z");
    await seedUsage(org, "2026-05-20T00:00:00.000Z", 999); // before the org existed → not counted
    await seedUsage(org, "2026-06-10T00:00:00.000Z", 7);
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(await withTenant(app, org, (tx) => sumPeriodEventUsage(tx, period, NOW))).toBe(7);
  });
});

describe("sumPeriodEventUsage — period.end clamp on the rolled half", () => {
  it("excludes rolled `usage` at/after period.end (a lapsed window can't accumulate past its end)", async () => {
    const org = await seedOrg();
    await seedUsage(org, "2026-07-02T00:00:00.000Z", 50); // before period.end → counted
    await seedUsage(org, "2026-07-12T00:00:00.000Z", 70); // AT/AFTER period.end → clamped out
    // A period that ended 2026-07-10, evaluated at NOW (2026-07-15, past the end): the rolled half must be
    // bounded by period.end, not just todayStart, so the 07-12 usage does not leak in.
    const period = { start: "2026-07-01T00:00:00.000Z", end: "2026-07-10T00:00:00.000Z" };
    const total = await withTenant(app, org, (tx) => sumPeriodEventUsage(tx, period, NOW));
    expect(total).toBe(50); // only the pre-end day; the 07-12 bucket is excluded by `< period.end`
  });

  it("the LIVE half excludes same-day events at/after a NON-midnight period.end (final cycle day)", async () => {
    // now is on the final cycle day; period.end is mid-day (a raw Stripe instant). The live query
    // `received_at < period.end` must exclude same-UTC-day events that occur AT/AFTER that instant.
    const org = await seedOrg();
    const NOW_LAST_DAY = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18 12:00 (the final cycle day)
    const period = { start: "2026-07-01T00:00:00.000Z", end: "2026-07-18T09:00:00.000Z" };
    await seedEventAt(org, "2026-07-18T06:00:00.000Z"); // before period.end → counted (live)
    await seedEventAt(org, "2026-07-18T10:00:00.000Z"); // AT/AFTER period.end → excluded
    const total = await withTenant(app, org, (tx) => sumPeriodEventUsage(tx, period, NOW_LAST_DAY));
    expect(total).toBe(1); // only the pre-end same-day event
  });
});
