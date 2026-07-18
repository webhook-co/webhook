import { randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  meterEventTimestampSeconds,
  runMeterReporter,
  type MeterReportSink,
} from "../src/meter-reporter";
import { flushOrgTail } from "../src/tail-flush";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The S4.5 tail-flush (invoice.created hook). The hourly reporter only sends FINALIZED days, so the last
// ~settleDays of a period reach Stripe after that period's invoice finalizes — where Stripe DROPS them
// (WS2). This flush FINALIZES the org's complete tail days (up to, but excluding, the boundary day that
// straddles the period end) and DRAINS them within the draft grace, reusing the reporter's exact idempotent
// claim→report→finalize path. It runs as webhook_app under RLS (finalize is a NULL→now the F1 trigger
// allows). The boundary day is left for the next period — the bounded residual the reconciler alarms on.

const EVENT_NAME = "webhook_events";
const SETTLE_DAYS = 2;
// The closing period ends mid-day on 2026-07-07, so the boundary day is 07-07 and the complete tail is
// 07-04/05/06. period end in ms; flushCutoff = 2026-07-07T00:00Z.
const PERIOD_END_MS = Date.UTC(2026, 6, 7, 8, 0, 0);
const FLOOR = "2026-06-20"; // subscription day — days before this are never billed

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;
let admin: Sql;

function fakeSink(failFor?: Set<string>): {
  sink: MeterReportSink;
  calls: Array<{ value: number; identifier: string; timestamp?: number }>;
} {
  const calls: Array<{ value: number; identifier: string; timestamp?: number }> = [];
  const sink: MeterReportSink = {
    async reportMeterEvent({ value, identifier, timestamp }) {
      if (failFor?.has(identifier)) throw new Error(`stripe boom for ${identifier}`);
      calls.push({ value, identifier, timestamp });
      return { identifier };
    },
  };
  return { sink, calls };
}

/** A paying org with an endpoint (events FK) + billing rows. floorDay = the subscription's created_at. */
async function seedOrg(opts: { customer?: string | null } = {}): Promise<{
  orgId: string;
  endpointId: string;
}> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
  });
  const customer = opts.customer === undefined ? `cus_${orgId.slice(0, 6)}` : opts.customer;
  if (customer) {
    await admin`insert into billing_customers (org_id, stripe_customer_id) values (${orgId}, ${customer})`;
  }
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end, created_at)
    values (${orgId}, ${`sub_${orgId.slice(0, 6)}`}, ${"pro"}, ${"active"},
            ${"2026-07-01T00:00:00Z"}, ${"2026-07-07T08:00:00Z"}, ${`${FLOOR}T00:00:00Z`})`;
  return { orgId, endpointId };
}

/** Seed `n` events on the UTC day `dayIso` (received_at is trigger-stamped, so UPDATE it after insert). */
async function seedEvents(
  orgId: string,
  endpointId: string,
  n: number,
  dayIso: string,
): Promise<void> {
  const at = new Date(Date.parse(dayIso) + 3_600_000).toISOString(); // 01:00 that UTC day
  await withTenant(app, orgId, async (tx) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const key = `${dayIso}-${i}`;
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${id}, ${orgId}, ${endpointId}, ${key}, ${10}, ${key}, ${"content_hash"})`;
      await tx`update events set received_at = ${at} where id = ${id}`;
    }
  });
}

async function usageDays(
  orgId: string,
): Promise<Array<{ day: string; count: number; finalized: boolean }>> {
  return withTenant(app, orgId, async (tx) => {
    const rows = await tx<{ day: string; count: string; finalized: boolean }[]>`
      select window_start::date::text as day, event_count::text as count,
             (finalized_at is not null) as finalized
      from usage order by window_start`;
    return rows.map((r) => ({ day: r.day, count: Number(r.count), finalized: r.finalized }));
  });
}

async function outbox(orgId: string): Promise<Array<{ day: string; status: string }>> {
  return withTenant(app, orgId, async (tx) => {
    const rows = await tx<{ day: string; status: string }[]>`
      select day::text as day, status from stripe_meter_reports order by day`;
    return rows.map((r) => ({ day: r.day, status: r.status }));
  });
}

function flush(orgId: string, stripe: MeterReportSink) {
  return flushOrgTail(
    { app, stripe, eventName: EVENT_NAME },
    { orgId, floorDay: FLOOR, periodEndMs: PERIOD_END_MS, settleDays: SETTLE_DAYS },
  );
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
  admin = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from stripe_meter_reports`;
  await admin`delete from delivery_attempts`;
  await admin`delete from usage`;
  await admin`delete from events`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from billing_customers`;
  await admin`delete from endpoints`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await admin?.end();
  await pg?.stop();
});

describe("flushOrgTail", () => {
  it("finalizes + reports the complete tail, leaving the boundary day unbilled", async () => {
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 100, "2026-07-04");
    await seedEvents(orgId, endpointId, 50, "2026-07-05");
    await seedEvents(orgId, endpointId, 30, "2026-07-06");
    await seedEvents(orgId, endpointId, 20, "2026-07-07"); // boundary day — must NOT be billed here

    const { sink, calls } = fakeSink();
    const res = await flush(orgId, sink);

    expect(res).toMatchObject({
      finalized: 3,
      produced: 3,
      sent: 3,
      failed: 0,
      skippedNoCustomer: 0,
    });

    // Exactly the three complete tail days, each stamped at 00:00 UTC of that day, in the period.
    expect(calls.sort((a, b) => a.identifier.localeCompare(b.identifier))).toEqual([
      {
        value: 100,
        identifier: `${orgId}:2026-07-04`,
        timestamp: meterEventTimestampSeconds("2026-07-04"),
      },
      {
        value: 50,
        identifier: `${orgId}:2026-07-05`,
        timestamp: meterEventTimestampSeconds("2026-07-05"),
      },
      {
        value: 30,
        identifier: `${orgId}:2026-07-06`,
        timestamp: meterEventTimestampSeconds("2026-07-06"),
      },
    ]);

    // The boundary day was never rolled/finalized/billed — it is the deferred residual.
    const days = await usageDays(orgId);
    expect(days.filter((d) => d.finalized).map((d) => d.day)).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
    ]);
    expect(days.some((d) => d.day === "2026-07-07")).toBe(false);
    expect(await outbox(orgId)).toEqual([
      { day: "2026-07-04", status: "sent" },
      { day: "2026-07-05", status: "sent" },
      { day: "2026-07-06", status: "sent" },
    ]);
  });

  it("is idempotent — a second flush finalizes nothing and sends nothing", async () => {
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 40, "2026-07-05");
    await seedEvents(orgId, endpointId, 20, "2026-07-07");

    await flush(orgId, fakeSink().sink);
    const { sink, calls } = fakeSink();
    const res = await flush(orgId, sink);

    expect(res).toMatchObject({ finalized: 0, produced: 0, sent: 0 });
    expect(calls).toEqual([]);
  });

  it("re-rolls with ONE bounded rollup_usage statement per day, not one over N days (#637)", async () => {
    // The fix's whole point: the re-roll must be per-day-bounded statements, not a single unbounded
    // generate_series over the window. A `debug` hook counts the rollup_usage calls the flush actually issues:
    // the new per-day loop makes exactly `rerollDays` of them; the old single-statement form made 1. So this
    // FAILS if anyone reverts to the unbounded roll (the exact revenue-path regression #637 removed) — a
    // guard the count-preserving behavioural tests can't give. reroll window = [cutoff-(settleDays+2),
    // cutoff-1] = [07-03..07-06] = 4 days.
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 10, "2026-07-05");

    let rollupCalls = 0;
    // A dedicated app-role client with prepare:false so each rollup arrives as full SQL text the debug hook
    // can match (a prepared statement would send the text once then execute by name).
    const countingApp = postgres(pg.urlFor({ role: DB_ROLES.app }), {
      prepare: false,
      fetch_types: false,
      max: 2,
      debug: (_conn, query) => {
        if (query.includes("rollup_usage(")) rollupCalls++;
      },
    });
    try {
      await flushOrgTail(
        { app: countingApp, stripe: fakeSink().sink, eventName: EVENT_NAME },
        { orgId, floorDay: FLOOR, periodEndMs: PERIOD_END_MS, settleDays: SETTLE_DAYS },
      );
    } finally {
      await countingApp.end();
    }

    // rerollDays = SETTLE_DAYS(2) + REROLL_MARGIN_DAYS(2) = 4 → four separate bounded statements.
    expect(rollupCalls).toBe(4);
  });

  // The counting test above proves the re-roll is 4 BOUNDED statements; this proves they COMMIT per-day, so a
  // mid-window failure is RESUMABLE — the exact revenue-path claim the docstring makes, on a real Postgres.
  // A BEFORE trigger on `usage` aborts exactly the 3rd reroll day's rollup, so the flush throws after the
  // first two days have already committed in their own transactions.
  it("re-roll commits per-day, so a mid-window failure resumes without double-billing (#637)", async () => {
    const { orgId, endpointId } = await seedOrg();
    // Distinct per-day counts across the whole reroll window [07-03..07-06] (oldest→newest).
    await seedEvents(orgId, endpointId, 3, "2026-07-03");
    await seedEvents(orgId, endpointId, 5, "2026-07-04");
    await seedEvents(orgId, endpointId, 7, "2026-07-05");
    await seedEvents(orgId, endpointId, 2, "2026-07-06");

    // Poison the 3rd reroll day: a BEFORE trigger raises when rollup_usage upserts the 07-05 row, aborting
    // ONLY that day's transaction. If the re-roll shared one transaction, this would roll back ALL four days.
    await admin`create or replace function tf_poison_637() returns trigger language plpgsql as $$
      begin
        if new.window_start::date = date '2026-07-05' then raise exception 'tf_poison_637'; end if;
        return new;
      end $$`;
    await admin`create trigger tf_poison_637_trg before insert or update on usage
      for each row execute function tf_poison_637()`;

    try {
      await expect(flush(orgId, fakeSink().sink)).rejects.toThrow(/tf_poison_637/);
      // Per-day commit independence: the two days BEFORE the failure are rolled AND committed (visible on a
      // fresh read despite the later abort); nothing is finalized and the Stripe drain never ran.
      const partial = await usageDays(orgId);
      expect(partial.map((d) => d.day)).toEqual(["2026-07-03", "2026-07-04"]);
      expect(partial.map((d) => d.count)).toEqual([3, 5]);
      expect(partial.every((d) => !d.finalized)).toBe(true);
      expect(await outbox(orgId)).toEqual([]);
    } finally {
      await admin`drop trigger tf_poison_637_trg on usage`;
      await admin`drop function tf_poison_637()`;
    }

    // Resume: a re-run completes every day, finalizes the whole pre-boundary tail, and drains to Stripe with
    // each day billed EXACTLY once — the two days that had committed before the failure are NOT re-billed.
    const { sink, calls } = fakeSink();
    const res = await flush(orgId, sink);
    const done = await usageDays(orgId);
    expect(done.map((d) => d.day)).toEqual([
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
    ]);
    expect(done.map((d) => d.count)).toEqual([3, 5, 7, 2]);
    expect(done.every((d) => d.finalized)).toBe(true);
    expect(res.finalized).toBe(4);
    const identifiers = calls.map((c) => c.identifier);
    expect(identifiers.length).toBe(4);
    expect(new Set(identifiers).size).toBe(4); // each tail day billed once — no double-bill on resume
  });

  it("does not double-bill when the normal reporter runs after a flush", async () => {
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 40, "2026-07-05");

    await flush(orgId, fakeSink().sink);
    // The hourly reporter enumerates this paying org and would re-produce/re-send — but the outbox rows are
    // already 'sent', so it must be a no-op (identifier {org}:{day} + the sent state guard).
    const { sink, calls } = fakeSink();
    await runMeterReporter({
      meter,
      app,
      stripe: sink,
      eventName: EVENT_NAME,
      now: PERIOD_END_MS,
      limit: 1000,
    });
    expect(calls).toEqual([]);
  });

  it("finalizes the tail but leaves rows pending when the Stripe customer link is missing", async () => {
    const { orgId, endpointId } = await seedOrg({ customer: null });
    await seedEvents(orgId, endpointId, 40, "2026-07-05");

    const { sink, calls } = fakeSink();
    const res = await flush(orgId, sink);

    expect(res).toMatchObject({ finalized: 1, produced: 1, sent: 0, skippedNoCustomer: 1 });
    expect(calls).toEqual([]);
    expect(await outbox(orgId)).toEqual([{ day: "2026-07-05", status: "pending" }]);
  });

  it("surfaces a Stripe send failure as `failed` and leaves that day retryable", async () => {
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 40, "2026-07-05");
    await seedEvents(orgId, endpointId, 30, "2026-07-06");

    // Fail only 07-05 — both the initial attempt and the one retry throw for it.
    const { sink, calls } = fakeSink(new Set([`${orgId}:2026-07-05`]));
    const res = await flush(orgId, sink);

    expect(res.sent).toBe(1); // 07-06 landed
    expect(res.failed).toBe(1); // 07-05 still unsent
    expect(calls.map((c) => c.identifier)).toEqual([`${orgId}:2026-07-06`]);
    const rows = await outbox(orgId);
    expect(rows.find((r) => r.day === "2026-07-05")?.status).toBe("sending"); // retryable, not lost
    expect(rows.find((r) => r.day === "2026-07-06")?.status).toBe("sent");
  });

  it("excludes a day when the period ends exactly at UTC midnight (no partial-day residual)", async () => {
    const { orgId, endpointId } = await seedOrg();
    await seedEvents(orgId, endpointId, 15, "2026-07-05");
    await seedEvents(orgId, endpointId, 25, "2026-07-06");

    // Period ends exactly at 2026-07-07T00:00Z → boundary day 07-07 has no in-period usage; cutoff is
    // still 07-07T00:00Z, so 07-05 and 07-06 (complete) flush and nothing spurious is finalized.
    const { sink, calls } = fakeSink();
    const res = await flushOrgTail(
      { app, stripe: sink, eventName: EVENT_NAME },
      {
        orgId,
        floorDay: FLOOR,
        periodEndMs: Date.UTC(2026, 6, 7, 0, 0, 0),
        settleDays: SETTLE_DAYS,
      },
    );
    expect(res).toMatchObject({ finalized: 2, sent: 2 });
    expect(calls.map((c) => c.identifier).sort()).toEqual([
      `${orgId}:2026-07-05`,
      `${orgId}:2026-07-06`,
    ]);
  });
});
