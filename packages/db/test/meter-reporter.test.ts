import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import postgres from "postgres";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  meterEventTimestampSeconds,
  reportOrgMeter,
  runMeterReporter,
  type MeterReportSink,
} from "../src/meter-reporter";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The S4.4c outbound meter-reporter: per paying org, produce stripe_meter_reports outbox rows for
// FINALIZED daily usage (immutable ledger, F1) and drain them to a Stripe Billing Meter via the outbox
// state machine (pending → sending → sent). identifier = {org}:{day} is Stripe's dedup key (F5), so a
// retried report is a no-op. Free orgs (no subscription) never report; a pre-subscription day is never
// billed; an open (unfinalized) or zero-count day is never produced.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z
const EVENT_NAME = "webhook_events";
const SUB_CREATED = "2026-07-05T00:00:00.000Z"; // the meter floor — days before this are not billed

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;
let admin: Sql; // superuser — seeds SELECT-only billing_* rows + cross-org cleanup between tests

/** A fake Stripe meter sink: records every reported event, and can be told to throw for one identifier. */
function fakeSink(failFor?: Set<string>): {
  sink: MeterReportSink;
  calls: Array<{ customer: string; value: number; identifier: string; timestamp?: number }>;
} {
  const calls: Array<{ customer: string; value: number; identifier: string; timestamp?: number }> =
    [];
  const sink: MeterReportSink = {
    async reportMeterEvent({ customer, value, identifier, timestamp }) {
      if (failFor?.has(identifier)) throw new Error(`stripe boom for ${identifier}`);
      calls.push({ customer, value, identifier, timestamp });
      return { identifier };
    },
  };
  return { sink, calls };
}

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

/** A paying org: a billing_customers + billing_subscriptions row (both SELECT-only → seed as superuser). */
async function seedPayingOrg(
  opts: { customer?: string | null; status?: string; created?: string } = {},
): Promise<string> {
  const orgId = await seedOrg();
  const { customer = `cus_${orgId.slice(0, 6)}`, status = "active", created = SUB_CREATED } = opts;
  if (customer) {
    await admin`insert into billing_customers (org_id, stripe_customer_id) values (${orgId}, ${customer})`;
  }
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end, created_at)
    values (${orgId}, ${`sub_${orgId.slice(0, 6)}`}, ${"pro"}, ${status},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"}, ${created})`;
  return orgId;
}

/** Seed a usage day. `finalized` sets finalized_at (an immutable, billable snapshot). */
async function seedUsage(
  orgId: string,
  dayIso: string,
  count: number,
  finalized: boolean,
): Promise<void> {
  const finalizedAt = finalized ? "2026-07-15T00:00:00Z" : null;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count, finalized_at)
             values (${orgId}, ${dayIso}, ${count}, ${finalizedAt})`;
  });
}

async function outboxRows(
  orgId: string,
): Promise<
  Array<{ day: string; status: string; event_count: number; attempts: number; ack: string | null }>
> {
  return withTenant(app, orgId, async (tx) => {
    const rows = await tx<
      {
        day: string;
        status: string;
        event_count: string;
        attempts: number;
        ack: string | null;
      }[]
    >`
      select day::text as day, status, event_count::text as event_count, attempts,
             stripe_meter_event_id as ack
      from stripe_meter_reports order by day`;
    return rows.map((r) => ({
      day: r.day,
      status: r.status,
      event_count: Number(r.event_count),
      attempts: r.attempts,
      ack: r.ack,
    }));
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
  admin = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  // Ordered deletes (the append-only usage/outbox guards forbid a blanket TRUNCATE CASCADE).
  await admin`delete from stripe_meter_reports`;
  await admin`delete from usage`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from billing_customers`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await admin?.end();
  await pg?.stop();
});

function run(stripe: MeterReportSink, limit = 1000) {
  return runMeterReporter({ meter, app, stripe, eventName: EVENT_NAME, now: NOW, limit });
}

describe("meterEventTimestampSeconds", () => {
  it("is the unix seconds of 00:00 UTC of the given day", () => {
    expect(meterEventTimestampSeconds("2026-07-15")).toBe(Math.floor(Date.UTC(2026, 6, 15) / 1000));
  });
});

describe("runMeterReporter — produce", () => {
  it("produces + sends an outbox row for a finalized, post-subscription, non-zero day", async () => {
    const org = await seedPayingOrg();
    await seedUsage(org, "2026-07-10T00:00:00Z", 500, true);
    const { sink, calls } = fakeSink();

    const res = await run(sink);

    expect(res.produced).toBe(1);
    expect(res.sent).toBe(1);
    const rows = await outboxRows(org);
    expect(rows).toEqual([
      {
        day: "2026-07-10",
        status: "sent",
        event_count: 500,
        attempts: 1,
        ack: `${org}:2026-07-10`,
      },
    ]);
    expect(calls).toEqual([
      {
        customer: `cus_${org.slice(0, 6)}`,
        value: 500,
        identifier: `${org}:2026-07-10`,
        timestamp: meterEventTimestampSeconds("2026-07-10"),
      },
    ]);
  });

  it("does NOT produce an OPEN (unfinalized) day — only frozen days are billable", async () => {
    const org = await seedPayingOrg();
    await seedUsage(org, "2026-07-14T00:00:00Z", 200, false);
    const res = await run(fakeSink().sink);
    expect(res.produced).toBe(0);
    expect(await outboxRows(org)).toEqual([]);
  });

  it("does NOT produce a ZERO-count day (nothing to bill, no meter noise)", async () => {
    const org = await seedPayingOrg();
    await seedUsage(org, "2026-07-11T00:00:00Z", 0, true);
    const res = await run(fakeSink().sink);
    expect(res.produced).toBe(0);
  });

  it("does NOT produce a day BEFORE the org subscribed (no pre-subscription Free usage billed)", async () => {
    const org = await seedPayingOrg({ created: "2026-07-08T00:00:00Z" });
    await seedUsage(org, "2026-07-03T00:00:00Z", 999, true); // before the floor
    await seedUsage(org, "2026-07-09T00:00:00Z", 7, true); // on/after the floor
    const res = await run(fakeSink().sink);
    expect(res.produced).toBe(1);
    expect((await outboxRows(org)).map((r) => r.day)).toEqual(["2026-07-09"]);
  });

  it("does NOT report for a Free org (no subscription row)", async () => {
    const org = await seedOrg();
    await seedUsage(org, "2026-07-10T00:00:00Z", 300, true);
    const res = await run(fakeSink().sink);
    expect(res.orgsProcessed).toBe(0);
    expect(res.produced).toBe(0);
  });

  it("excludes a fully-canceled subscription from enumeration", async () => {
    const org = await seedPayingOrg({ status: "canceled" });
    await seedUsage(org, "2026-07-10T00:00:00Z", 42, true);
    const res = await run(fakeSink().sink);
    expect(res.orgsProcessed).toBe(0);
  });
});

describe("runMeterReporter — drain + idempotency", () => {
  it("is idempotent: a second pass produces nothing new and never re-sends a sent day", async () => {
    const org = await seedPayingOrg();
    await seedUsage(org, "2026-07-10T00:00:00Z", 500, true);
    await run(fakeSink().sink);

    const { sink, calls } = fakeSink();
    const res = await run(sink);
    expect(res.produced).toBe(0);
    expect(res.sent).toBe(0);
    expect(calls).toEqual([]); // the already-sent day is never reported again
  });

  it("leaves a failed send RETRYABLE (sending, attempt counted) and a later pass resends it", async () => {
    const org = await seedPayingOrg();
    await seedUsage(org, "2026-07-10T00:00:00Z", 500, true);
    const id = `${org}:2026-07-10`;

    const first = await run(fakeSink(new Set([id])).sink);
    expect(first.produced).toBe(1);
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(1);
    let rows = await outboxRows(org);
    expect(rows[0]!.status).toBe("sending"); // claimed, not sent
    expect(rows[0]!.attempts).toBe(1); // the failed send counted an attempt
    expect(rows[0]!.ack).toBeNull();

    // A later pass (Stripe healthy) resends the SAME identifier and completes it.
    const { sink, calls } = fakeSink();
    const second = await run(sink);
    expect(second.sent).toBe(1);
    expect(calls[0]!.identifier).toBe(id); // same idempotency key → Stripe dedups if the first partially landed
    rows = await outboxRows(org);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.attempts).toBe(2); // the resend counted a second attempt
  });

  it("skips draining when the org has no Stripe customer yet (stays pending, retryable)", async () => {
    const org = await seedPayingOrg({ customer: null });
    await seedUsage(org, "2026-07-10T00:00:00Z", 500, true);
    const { sink, calls } = fakeSink();
    const res = await run(sink);
    expect(res.produced).toBe(1);
    expect(res.sent).toBe(0);
    expect(res.skippedNoCustomer).toBe(1);
    expect(calls).toEqual([]);
    expect((await outboxRows(org))[0]!.status).toBe("pending"); // never claimed — a later pass retries
  });
});

describe("runMeterReporter — enumeration bounds + cross-org isolation", () => {
  it("truncates at `limit` and reports `capped` (the unprocessed tail drains on a later pass)", async () => {
    const a = await seedPayingOrg();
    const b = await seedPayingOrg();
    await seedUsage(a, "2026-07-10T00:00:00Z", 10, true);
    await seedUsage(b, "2026-07-10T00:00:00Z", 20, true);

    const first = await run(fakeSink().sink, 1); // process at most ONE org this pass
    expect(first.orgsProcessed).toBe(1);
    expect(first.capped).toBe(true);

    // The other org is untouched this pass; a later (uncapped) pass processes both, sending only the
    // as-yet-unsent org's day (the already-sent one is never re-reported).
    const { calls } = fakeSink();
    const second = await run({ reportMeterEvent: async (a) => ({ identifier: a.identifier }) });
    expect(second.orgsProcessed).toBe(2);
    expect(second.capped).toBe(false);
    // Across both passes exactly one row per org reached 'sent'.
    expect((await outboxRows(a))[0]!.status).toBe("sent");
    expect((await outboxRows(b))[0]!.status).toBe("sent");
    void calls;
  });

  it("keeps two orgs' reports isolated — each org's own customer, count, and identifier (no mix-up)", async () => {
    const a = await seedPayingOrg({ customer: "cus_AAA" });
    const b = await seedPayingOrg({ customer: "cus_BBB" });
    await seedUsage(a, "2026-07-10T00:00:00Z", 111, true);
    await seedUsage(b, "2026-07-10T00:00:00Z", 222, true);

    const { sink, calls } = fakeSink();
    const res = await run(sink);
    expect(res.produced).toBe(2);
    expect(res.sent).toBe(2);

    // Order-insensitive: each org's Stripe call carries ITS OWN customer + count + {org}:{day} identifier.
    const byCustomer = Object.fromEntries(calls.map((c) => [c.customer, c]));
    expect(byCustomer["cus_AAA"]).toMatchObject({ value: 111, identifier: `${a}:2026-07-10` });
    expect(byCustomer["cus_BBB"]).toMatchObject({ value: 222, identifier: `${b}:2026-07-10` });
    // And each org's outbox holds only its own row (RLS-scoped read).
    expect((await outboxRows(a)).map((r) => r.event_count)).toEqual([111]);
    expect((await outboxRows(b)).map((r) => r.event_count)).toEqual([222]);
  });

  it("reportOrgMeter pins UTC — a non-UTC connection still stamps the meter day at UTC (regression)", async () => {
    // window_start::date is session-TimeZone-dependent. On a connection whose DEFAULT TimeZone is west of
    // UTC, a UTC-midnight window renders as the PREVIOUS calendar day → the {org}:{day} identifier + meter
    // timestamp would be a day early (into an already-finalized Stripe period → dropped). The `set local time
    // zone 'UTC'` in reportOrgMeter must override that default. This test fails if the pin is removed.
    const orgId = await seedPayingOrg({ customer: "cus_TZ" });
    await seedUsage(orgId, "2026-07-05T00:00:00Z", 42, true); // finalized, UTC-midnight
    // A client whose startup TimeZone is America/New_York (UTC-4/5) — the untrusted non-UTC default.
    const ny = postgres(pg.urlFor({ role: DB_ROLES.app }), {
      prepare: true,
      fetch_types: false,
      max: 1,
      connection: { TimeZone: "America/New_York" },
    });
    try {
      const { sink, calls } = fakeSink();
      await reportOrgMeter({ app: ny, stripe: sink, eventName: EVENT_NAME }, orgId, "2026-07-01");
      // Without the pin this would be `${orgId}:2026-07-04` at meterEventTimestampSeconds("2026-07-04").
      expect(calls).toEqual([
        {
          customer: "cus_TZ",
          value: 42,
          identifier: `${orgId}:2026-07-05`,
          timestamp: meterEventTimestampSeconds("2026-07-05"),
        },
      ]);
    } finally {
      await ny.end();
    }
  });
});
