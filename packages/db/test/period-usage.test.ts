import { randomUUID } from "node:crypto";

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

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

async function seedUsage(orgId: string, windowIso: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${windowIso}, ${count})`;
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
  await admin`delete from usage`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await pg?.stop();
});

describe("effectiveBillingPeriod", () => {
  it("uses the UTC calendar month when the org has NO subscription (Free default)", async () => {
    const org = await seedOrg();
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period).toEqual({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z",
    });
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
    });
  });

  it("falls back to the UTC month when the Stripe cycle has LAPSED (now past current_period_end)", async () => {
    const org = await seedOrg();
    // A cycle that ended BEFORE now (a late/missing renewal webhook) must not anchor — a paid org would
    // otherwise be measured over a stale/ended window and could stay stranded paused into the new cycle.
    await seedSubscription(org, { start: "2026-06-05T00:00:00Z", end: "2026-07-05T00:00:00Z" }); // end < NOW
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period.start).toBe("2026-07-01T00:00:00.000Z"); // UTC month fallback
  });

  it("falls back to the UTC month for a CANCELED subscription (→ Free)", async () => {
    const org = await seedOrg();
    await seedSubscription(org, {
      status: "canceled",
      start: "2026-06-18T00:00:00Z",
      end: "2026-07-18T00:00:00Z",
    });
    const period = await withTenant(app, org, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period.start).toBe("2026-07-01T00:00:00.000Z"); // UTC month, not the stale sub cycle
  });

  it("is RLS-scoped — org A's period never reflects org B's subscription", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await seedSubscription(b, { start: "2026-06-18T00:00:00Z", end: "2026-07-18T00:00:00Z" });
    // A has no subscription → UTC month, unaffected by B's cycle.
    const period = await withTenant(app, a, (tx) => effectiveBillingPeriod(tx, NOW));
    expect(period.start).toBe("2026-07-01T00:00:00.000Z");
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
});
