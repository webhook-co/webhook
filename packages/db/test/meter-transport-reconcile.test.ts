import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  reconcileStripeTransport,
  type MeterSummaryReader,
} from "../src/meter-transport-reconcile";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// WS1 transport reconciliation: compare what we TOLD Stripe (the outbox `sent` rows) to what Stripe
// AGGREGATED (event summaries). A drift = a meter event Stripe dropped (or a stale value). Read-only, under
// the dedicated webhook_meter_transport role; the Stripe-summary reader is an injected seam (no HTTP here).

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z
const DAY_MS = 86_400_000;

let pg: EphemeralPostgres;
let transport: Sql; // the reconciliation role under test — cross-org, read-only
let admin: Sql; // owner: seeds outbox + billing_customers (both FORCE RLS) and cleans up

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await admin`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  return orgId;
}

async function seedCustomer(org: string, customer: string): Promise<void> {
  await admin`insert into billing_customers (org_id, stripe_customer_id) values (${org}, ${customer})`;
}

/** A `sent` outbox row for (org, day) carrying the value we POSTed to Stripe. */
async function seedSent(org: string, day: string, count: number, status = "sent"): Promise<void> {
  await admin`
    insert into stripe_meter_reports (org_id, day, event_count, identifier, status, sent_at)
    values (${org}, ${day}, ${count}, ${org + ":" + day}, ${status},
            ${status === "sent" ? "2026-07-13T00:00:00Z" : null})`;
}

/** UTC-midnight unix seconds for a YYYY-MM-DD. */
const daySec = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

/**
 * A faked Stripe-summary reader driven by a customer→(day→aggregated) map. Returns one day-summary per
 * mapped day that falls in [startSec, endSec) — exactly the shape the real client adapter produces.
 */
function fakeReader(byCustomer: Record<string, Record<string, number>>): MeterSummaryReader {
  return {
    async listDaySummaries(customer, startSec, endSec) {
      const days = byCustomer[customer] ?? {};
      return Object.entries(days)
        .map(([day, aggregated]) => ({ startSec: daySec(day), aggregated }))
        .filter((s) => s.startSec >= startSec && s.startSec < endSec);
    },
  };
}

function run(reader: MeterSummaryReader, opts: { limit?: number; lookbackDays?: number } = {}) {
  return reconcileStripeTransport({
    audit: transport,
    reader,
    now: NOW,
    settleLagMs: DAY_MS, // 24h → days < 2026-07-14 are settled
    lookbackDays: opts.lookbackDays ?? 40,
    limit: opts.limit ?? 1000,
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  transport = createClient(pg.urlFor({ role: DB_ROLES.meterTransport }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from stripe_meter_reports`;
  await admin`delete from billing_customers`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await transport?.end();
  await admin?.end();
  await pg?.stop();
});

describe("reconcileStripeTransport", () => {
  it("no drift when Stripe's aggregate equals what we sent", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-12", 100);
    const res = await run(fakeReader({ cus_1: { "2026-07-12": 100 } }));
    expect(res.mismatches).toEqual([]);
    expect(res.daysChecked).toBe(1);
    expect(res.orgsChecked).toBe(1);
  });

  it("drifts when Stripe has NO summary for a sent day (a full drop)", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-12", 100);
    const res = await run(fakeReader({ cus_1: {} }));
    expect(res.mismatches).toEqual([
      { orgId: org, day: "2026-07-12", reported: 100, stripe: null },
    ]);
  });

  it("drifts when Stripe aggregated LESS than we sent (a partial drop)", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-12", 100);
    const res = await run(fakeReader({ cus_1: { "2026-07-12": 60 } }));
    expect(res.mismatches).toEqual([{ orgId: org, day: "2026-07-12", reported: 100, stripe: 60 }]);
  });

  it("drifts when Stripe aggregated MORE than we sent (a stale value / double-count)", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-12", 100);
    const res = await run(fakeReader({ cus_1: { "2026-07-12": 140 } }));
    expect(res.mismatches).toEqual([{ orgId: org, day: "2026-07-12", reported: 100, stripe: 140 }]);
  });

  it("does NOT reconcile a day still inside the settle lag (Stripe aggregation not settled)", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-14", 100); // 2026-07-14 is NOT < 2026-07-14 → unsettled
    const res = await run(fakeReader({ cus_1: {} }));
    expect(res.daysChecked).toBe(0);
    expect(res.mismatches).toEqual([]);
  });

  it("is per-org — one org's drift never implicates another", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await seedCustomer(a, "cus_a");
    await seedCustomer(b, "cus_b");
    await seedSent(a, "2026-07-12", 100);
    await seedSent(b, "2026-07-12", 50);
    const res = await run(
      fakeReader({ cus_a: { "2026-07-12": 100 }, cus_b: { "2026-07-12": 999 } }),
    );
    expect(res.mismatches).toEqual([{ orgId: b, day: "2026-07-12", reported: 50, stripe: 999 }]);
  });

  it("skips (never false-drifts) an org with sent rows but no billing_customers row", async () => {
    const org = await seedOrg();
    await seedSent(org, "2026-07-12", 100); // no customer mapping
    const res = await run(fakeReader({}));
    expect(res.mismatches).toEqual([]);
    expect(res.skippedNoCustomer).toBe(1);
  });

  it("only reconciles status='sent' rows (pending/sending are not yet with Stripe)", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-12", 100, "pending");
    await seedSent(org, "2026-07-11", 50, "sending");
    const res = await run(fakeReader({ cus_1: {} }));
    expect(res.daysChecked).toBe(0);
    expect(res.mismatches).toEqual([]);
  });

  it("bounds the scan to the lookback horizon", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-05-01", 100); // ~75 days before NOW, outside a 40-day lookback
    const res = await run(fakeReader({ cus_1: {} }), { lookbackDays: 40 });
    expect(res.daysChecked).toBe(0);
    expect(res.mismatches).toEqual([]);
  });

  it("drifts on a day STRIPE aggregated but we never reported (a phantom charge between sent days)", async () => {
    // The money blind-spot: iterating only our sent days would miss a day Stripe billed the customer for
    // that we produced no `sent` row for. The day must be bracketed by sent days to fall in the query range.
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-11", 10);
    await seedSent(org, "2026-07-13", 30);
    const res = await run(
      fakeReader({ cus_1: { "2026-07-11": 10, "2026-07-12": 99, "2026-07-13": 30 } }),
    );
    expect(res.mismatches).toEqual([{ orgId: org, day: "2026-07-12", reported: 0, stripe: 99 }]);
  });

  it("counts an org whose Stripe read FAILS as errored (not checked) and never as a clean reconcile", async () => {
    const ok = await seedOrg();
    const bad = await seedOrg();
    await seedCustomer(ok, "cus_ok");
    await seedCustomer(bad, "cus_bad");
    await seedSent(ok, "2026-07-12", 100);
    await seedSent(bad, "2026-07-12", 50);
    const reader: MeterSummaryReader = {
      async listDaySummaries(customer, startSec, endSec) {
        if (customer === "cus_bad") throw new Error("stripe 500");
        return [{ startSec: daySec("2026-07-12"), aggregated: 100 }].filter(
          (x) => x.startSec >= startSec && x.startSec < endSec,
        );
      },
    };
    const res = await run(reader);
    expect(res.mismatches).toEqual([]); // ok org matches; bad org is not compared
    expect(res.orgsChecked).toBe(1); // only the ok org
    expect(res.erroredOrgs).toBe(1); // the bad org — an alarm signal
    expect(res.daysChecked).toBe(1); // the bad org's day is NOT counted as checked
  });

  it("bounds the drift LOG to `limit`, not just the returned list", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-10", 10);
    await seedSent(org, "2026-07-11", 20);
    await seedSent(org, "2026-07-12", 30);
    const logs: string[] = [];
    const res = await reconcileStripeTransport({
      audit: transport,
      reader: fakeReader({ cus_1: {} }), // every day drifts (full drop)
      now: NOW,
      settleLagMs: DAY_MS,
      lookbackDays: 40,
      limit: 2,
      log: (m) => logs.push(m),
    });
    expect(res.mismatches.length).toBe(2);
    expect(res.capped).toBe(true);
    // 3 days drift, but only `limit` (2) drift lines are logged (+ no done line here — the cron logs that).
    expect(logs.filter((m) => m === "metering.stripe_reconcile.drift").length).toBe(2);
  });

  it("caps the drift list at `limit` and flags it", async () => {
    const org = await seedOrg();
    await seedCustomer(org, "cus_1");
    await seedSent(org, "2026-07-11", 10);
    await seedSent(org, "2026-07-12", 20);
    const res = await run(fakeReader({ cus_1: {} }), { limit: 1 });
    expect(res.mismatches.length).toBe(1);
    expect(res.capped).toBe(true);
  });
});
