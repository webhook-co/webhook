import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  readDeliveryStatsSeries,
  runDeliveryStatsRollup,
  type DeliveryStatsDay,
} from "../src/delivery-stats-rollup";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The delivery-stats rollup (Lane 1.1): the dashboard-overview cache. A cron enumerates orgs with a recent
// delivery (cross-org, as webhook_meter), then per org re-rolls the settle-window days under webhook_app RLS
// into delivery_stats — counts by terminal status + p95 of DELIVERED latency. Unlike the metering rollup this
// is a DISPLAY cache, not billing, so there is no freeze: recent days simply refine as deliveries settle.

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0); // 2026-07-07T12:00Z — fixed for deterministic windows
const SETTLE_DAYS = 2;

// UTC-midnight ISO of the day `daysAgo` before NOW.
function dayIso(daysAgo: number): string {
  return new Date(Date.UTC(2026, 6, 7) - daysAgo * DAY_MS).toISOString();
}

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;

async function seedOrg(
  slug: string,
): Promise<{ orgId: string; endpointId: string; eventId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  const eventId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${eventId}, ${orgId}, ${endpointId}, ${slug + "-payload"}, ${10}, ${slug + "-dk"}, ${"content_hash"})`;
  });
  return { orgId, endpointId, eventId };
}

/** Seed one delivery_attempts row on the UTC day `daysAgo` with a terminal status + optional measured
 *  latency. One row = one dispatch (its status is the terminal outcome the rollup buckets). */
async function seedDelivery(
  orgId: string,
  eventId: string,
  status: string,
  daysAgo: number,
  durationMs: number | null,
): Promise<void> {
  const at = new Date(Date.UTC(2026, 6, 7) - daysAgo * DAY_MS + 3_600_000).toISOString();
  await withTenant(app, orgId, async (tx) => {
    const id = randomUUID();
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status, attempt, created_at, duration_ms)
             values (${id}, ${orgId}, ${eventId}, ${"https://x.test/t"}, ${status}, ${1}, ${at}, ${durationMs})`;
  });
}

async function statsAt(
  orgId: string,
  windowIso: string,
): Promise<{
  delivered: number;
  dead: number;
  blocked: number;
  p95: number | null;
} | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<
      {
        delivered_count: string;
        dead_count: string;
        blocked_count: string;
        p95_duration_ms: number | null;
      }[]
    >`select delivered_count, dead_count, blocked_count, p95_duration_ms
      from delivery_stats where org_id = ${orgId} and window_start = ${windowIso}`;
    return row
      ? {
          delivered: Number(row.delivered_count),
          dead: Number(row.dead_count),
          blocked: Number(row.blocked_count),
          p95: row.p95_duration_ms,
        }
      : null;
  });
}

async function run(now = NOW): Promise<void> {
  await runDeliveryStatsRollup({ meter, app, now, settleDays: SETTLE_DAYS, limit: 1000 });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await pg?.stop();
});

describe("runDeliveryStatsRollup", () => {
  it("counts terminal outcomes per org per day (RLS-isolated, in-flight excluded)", async () => {
    const a = await seedOrg("ds-a");
    const b = await seedOrg("ds-b");
    // Org A, today: 2 delivered, 1 dead, 1 blocked — plus a queued (in-flight, must NOT count).
    await seedDelivery(a.orgId, a.eventId, "delivered", 0, 120);
    await seedDelivery(a.orgId, a.eventId, "delivered", 0, 340);
    await seedDelivery(a.orgId, a.eventId, "dead", 0, null);
    await seedDelivery(a.orgId, a.eventId, "blocked", 0, null);
    await seedDelivery(a.orgId, a.eventId, "queued", 0, null);
    // Org A, yesterday: 1 delivered.
    await seedDelivery(a.orgId, a.eventId, "delivered", 1, 200);
    // Org B, today: 3 delivered (isolation check).
    await seedDelivery(b.orgId, b.eventId, "delivered", 0, 90);
    await seedDelivery(b.orgId, b.eventId, "delivered", 0, 90);
    await seedDelivery(b.orgId, b.eventId, "delivered", 0, 90);

    await run();

    expect(await statsAt(a.orgId, dayIso(0))).toMatchObject({ delivered: 2, dead: 1, blocked: 1 });
    expect(await statsAt(a.orgId, dayIso(1))).toMatchObject({ delivered: 1, dead: 0, blocked: 0 });
    // B's rollup never sees A's rows: exact counts, and no A row leaks into B's org.
    expect(await statsAt(b.orgId, dayIso(0))).toMatchObject({ delivered: 3, dead: 0, blocked: 0 });
    expect(await statsAt(b.orgId, dayIso(1))).toBeNull();
  });

  it("computes p95 over delivered rows with a measured duration only, else null", async () => {
    const { orgId, eventId } = await seedOrg("ds-p95");
    // Five delivered latencies 100..500 → percentile_cont(0.95) interpolates at rank 3.8 → 480.
    for (const ms of [100, 200, 300, 400, 500])
      await seedDelivery(orgId, eventId, "delivered", 0, ms);
    // A delivered row with NO measured duration (pre-0062 shape) is counted but excluded from p95.
    await seedDelivery(orgId, eventId, "delivered", 0, null);
    // A dead row carries a duration, but p95 is over DELIVERED only — it must not pull the percentile.
    await seedDelivery(orgId, eventId, "dead", 0, 9999);
    // Yesterday: a lone dead delivery, no delivered rows → p95 must be null (never a fabricated 0).
    await seedDelivery(orgId, eventId, "dead", 1, null);

    await run();

    expect(await statsAt(orgId, dayIso(0))).toEqual({
      delivered: 6,
      dead: 1,
      blocked: 0,
      p95: 480,
    });
    expect(await statsAt(orgId, dayIso(1))).toEqual({
      delivered: 0,
      dead: 1,
      blocked: 0,
      p95: null,
    });
  });

  it("re-rolls (upserts) the just-closed day as late deliveries settle", async () => {
    const { orgId, eventId } = await seedOrg("ds-settle");
    await seedDelivery(orgId, eventId, "delivered", 1, 100); // yesterday
    await run();
    expect(await statsAt(orgId, dayIso(1))).toMatchObject({ delivered: 1 });

    // A delivery created yesterday reaches its terminal status after the first pass; the next pass re-rolls.
    await seedDelivery(orgId, eventId, "delivered", 1, 300);
    await run();
    expect(await statsAt(orgId, dayIso(1))).toMatchObject({ delivered: 2, p95: 290 });
  });
});

describe("runDeliveryStatsRollup per-org isolation (unit, fakes)", () => {
  // One org's failure must not skip the rest of the pass. Deterministic fakes so the control flow is
  // actually exercised — a real DB error mid-rollup is hard to force, and asserting on a phantom org that
  // never fails would leave the try/catch untested. Mirrors usage-rollup's isolation test.
  it("isolates a failing org: logs it, counts it, and still processes the rest", async () => {
    const enumerated = [{ org_id: "ok-1" }, { org_id: "fail-1" }, { org_id: "ok-2" }];
    const fakeMeter = (() => Promise.resolve(enumerated)) as unknown as Sql;
    // withTenant(app, orgId, cb) → app.begin → tx`select set_config(guc, orgId, true)` then cb(tx).
    // Reject inside the begin for fail-1 (as its set_config runs) so THAT org throws and no other does.
    const fakeApp = {
      begin: async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("?");
          if (text.includes("set_config") && values.includes("fail-1")) {
            return Promise.reject(new Error("boom"));
          }
          return Promise.resolve([]);
        };
        return cb(tx);
      },
    } as unknown as Sql;

    const failedOrgs: string[] = [];
    const result = await runDeliveryStatsRollup({
      meter: fakeMeter,
      app: fakeApp,
      now: NOW,
      settleDays: 1,
      limit: 1000,
      log: (_message, fields) => {
        if (fields?.orgId) failedOrgs.push(String(fields.orgId));
      },
    });

    expect(result.orgsProcessed).toBe(3);
    expect(result.orgsSucceeded).toBe(2);
    expect(result.orgsFailed).toBe(1);
    expect(result.capped).toBe(false);
    expect(failedOrgs).toEqual(["fail-1"]);
  });
});

describe("readDeliveryStatsSeries", () => {
  it("returns this org's last-N-days series (oldest→newest), gaps omitted", async () => {
    const { orgId, eventId } = await seedOrg("ds-read");
    await seedDelivery(orgId, eventId, "delivered", 0, 120);
    await seedDelivery(orgId, eventId, "blocked", 0, null);
    await seedDelivery(orgId, eventId, "delivered", 1, 200);
    // Day 2 has no deliveries → no row → a gap the dashboard reads as zero.
    await run();

    const series: DeliveryStatsDay[] = await withTenant(app, orgId, (tx) =>
      readDeliveryStatsSeries(tx, 3, NOW),
    );

    expect(series.map((d) => d.windowStart)).toEqual([dayIso(1), dayIso(0)]);
    expect(series[1]).toMatchObject({ delivered: 1, blocked: 1, p95DurationMs: 120 });
  });

  it("does not read another org's series (RLS)", async () => {
    const a = await seedOrg("ds-read-a");
    const b = await seedOrg("ds-read-b");
    await seedDelivery(a.orgId, a.eventId, "delivered", 0, 100);
    await seedDelivery(b.orgId, b.eventId, "delivered", 0, 100);
    await run();

    const bSeries = await withTenant(app, b.orgId, (tx) => readDeliveryStatsSeries(tx, 3, NOW));
    expect(bSeries.every((d) => d.delivered === 1)).toBe(true);
    // b sees exactly its own single day, not a's.
    expect(bSeries).toHaveLength(1);
  });
});
