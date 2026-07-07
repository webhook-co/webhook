import { randomUUID } from "node:crypto";

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
  it("sums only the current-period usage windows and returns the period bounds", async () => {
    const orgId = await seedOrg("usage-sum");
    await seedUsage(orgId, "2026-07-02T00:00:00.000Z", 100); // in period
    await seedUsage(orgId, "2026-07-20T00:00:00.000Z", 25); // in period
    await seedUsage(orgId, "2026-06-30T00:00:00.000Z", 999); // prior month — excluded

    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));

    expect(summary.events).toBe(125);
    expect(summary.periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(summary.periodEnd.toISOString()).toBe("2026-08-01T00:00:00.000Z");
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
