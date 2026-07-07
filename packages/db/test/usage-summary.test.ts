import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { readUsageSummary } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// readUsageSummary (usage.get): the caller's org usage for the CURRENT billing period (UTC month
// until Stripe anchors it), plus the cap + pause behavior. RLS-scoped; single dimension = events.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → period [2026-07-01, 2026-08-01)

let pg: EphemeralPostgres;
let app: Sql;

async function seedOrg(slug: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
  });
  return orgId;
}

async function seedUsage(orgId: string, windowIso: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${windowIso}, ${count})`;
  });
}

// Seed `n` events on NOW's UTC day (today), so the live current-day count picks them up. received_at is
// trigger-stamped to now() on INSERT, so we UPDATE it to a today instant after.
async function seedEventsToday(orgId: string, n: number): Promise<void> {
  const endpointId = randomUUID();
  const at = "2026-07-15T06:00:00.000Z"; // within NOW's day
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${id}, ${orgId}, ${endpointId}, ${"k" + i}, ${10}, ${"d" + i}, ${"content_hash"})`;
      await tx`update events set received_at = ${at} where id = ${id}`;
    }
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("readUsageSummary", () => {
  it("sums prior-day rolled windows PLUS today's live events, and returns the period bounds", async () => {
    const orgId = await seedOrg("usage-sum");
    await seedUsage(orgId, "2026-07-02T00:00:00.000Z", 100); // prior day, rolled
    await seedUsage(orgId, "2026-07-10T00:00:00.000Z", 25); // prior day, rolled
    await seedUsage(orgId, "2026-06-30T00:00:00.000Z", 999); // prior month — excluded
    await seedEventsToday(orgId, 3); // today, not yet rolled — counted live

    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));

    expect(summary.events).toBe(128); // 100 + 25 + 3 live
    expect(summary.periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(summary.periodEnd.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("counts today's events live even before the rollup runs (no undercount)", async () => {
    const orgId = await seedOrg("usage-today-live");
    // No `usage` rows at all (rollup hasn't run today), just raw events today.
    await seedEventsToday(orgId, 7);
    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));
    expect(summary.events).toBe(7);
  });

  it("ignores a rolled `usage` row for TODAY in favor of the live count (no double-count at the boundary)", async () => {
    // The rollup re-rolls today hourly, so a `usage` row at window_start = todayStart CAN coexist with
    // today's raw events. The rolled query is strict (`window_start < todayStart`), so today's usage row
    // must be EXCLUDED and today counted live only — never both. A regression to `<=`/`< period.end`
    // here would double-count today (rolled + live); this pins the exact boundary.
    const orgId = await seedOrg("usage-today-boundary");
    await seedUsage(orgId, "2026-07-02T00:00:00.000Z", 100); // prior day, rolled — counts
    await seedUsage(orgId, "2026-07-15T00:00:00.000Z", 99); // TODAY, rolled — must be ignored
    await seedEventsToday(orgId, 4); // today live — counts
    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));
    expect(summary.events).toBe(104); // 100 prior + 4 live; the 99 today-rolled row is NOT added
  });

  it("defaults to uncapped + 'pause' + not-paused when org_limits / ingest_paused are unseeded", async () => {
    const orgId = await seedOrg("usage-default");
    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));
    expect(summary).toMatchObject({
      events: 0,
      eventCap: null,
      pausePolicy: "pause",
      paused: false,
    });
  });

  it("reflects the org's cap, pause policy, and org-level pause state", async () => {
    const orgId = await seedOrg("usage-limits");
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${500000}, ${"allow"})`;
      await tx`insert into ingest_paused (org_id, paused, reason, since) values (${orgId}, ${true}, ${"cap"}, now())`;
    });
    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));
    expect(summary.eventCap).toBe(500000);
    expect(summary.pausePolicy).toBe("allow");
    expect(summary.paused).toBe(true);
  });

  it("is RLS-scoped: one org never sees another's usage", async () => {
    const a = await seedOrg("usage-iso-a");
    const b = await seedOrg("usage-iso-b");
    await seedUsage(a, "2026-07-05T00:00:00.000Z", 7);
    await seedUsage(b, "2026-07-05T00:00:00.000Z", 9999);
    const summaryA = await withTenant(app, a, (tx) => readUsageSummary(tx, NOW));
    expect(summaryA.events).toBe(7);
  });
});
