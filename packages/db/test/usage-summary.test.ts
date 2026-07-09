import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { readUsageSummary } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// readUsageSummary (usage.get): the caller's org usage for the CURRENT billing period (UTC month
// until Stripe anchors it), plus the cap + pause behavior. RLS-scoped; single dimension = events.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → period [2026-07-01, 2026-08-01)

let pg: EphemeralPostgres;
let app: Sql;
let admin: Sql; // seeds SELECT-only billing_subscriptions

/** `created_at` anchors the Free tier's LIFETIME allowance window; default it well before any seeded usage
 *  (in prod an org's events can never predate it, but these fixtures use fake dates ahead of the real clock). */
const ORG_CREATED = "2026-01-01T00:00:00.000Z";
async function seedOrg(slug: string, createdAt = ORG_CREATED): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at) values (${orgId}, ${slug}, ${slug}, ${createdAt})`;
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
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await pg?.stop();
});

describe("readUsageSummary", () => {
  it("a FREE org: sums rolled + live over its ONE-TIME LIFETIME allowance (no period end)", async () => {
    const orgId = await seedOrg("usage-sum");
    await seedUsage(orgId, "2026-07-02T00:00:00.000Z", 100); // rolled
    await seedUsage(orgId, "2026-07-10T00:00:00.000Z", 25); // rolled
    await seedUsage(orgId, "2026-06-30T00:00:00.000Z", 999); // PRIOR MONTH — a lifetime allowance counts it
    await seedEventsToday(orgId, 3); // today, not yet rolled — counted live

    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));

    expect(summary.events).toBe(1127); // 999 + 100 + 25 rolled + 3 live — every event ever
    expect(summary.capKind).toBe("lifetime");
    expect(summary.periodStart.toISOString()).toBe(ORG_CREATED); // anchored at org creation
    expect(summary.periodEnd).toBeNull(); // a one-time allowance never resets
  });

  it("measures over the SUBSCRIPTION's Stripe cycle for a paid org, not the UTC month", async () => {
    const orgId = await seedOrg("usage-paid");
    // A signup-anchored cycle with a NON-midnight start 2026-06-18 14:30 → 2026-07-18 09:00 (straddles the
    // month boundary). The start floors to midnight, so the start-day `usage` bucket is included.
    await admin`
      insert into billing_subscriptions
        (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
      values (${orgId}, ${"sub_paid"}, ${"pro"}, ${"active"},
              ${"2026-06-18T14:30:00Z"}, ${"2026-07-18T09:00:00Z"})`;
    await seedUsage(orgId, "2026-06-18T00:00:00.000Z", 10); // the START-day bucket — included (floored start)
    await seedUsage(orgId, "2026-06-20T00:00:00.000Z", 40); // late-June, inside the cycle
    await seedUsage(orgId, "2026-07-02T00:00:00.000Z", 60);
    await seedUsage(orgId, "2026-06-10T00:00:00.000Z", 999); // BEFORE the cycle — excluded
    await seedEventsToday(orgId, 5); // today (2026-07-15) is within the cycle

    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW));
    expect(summary.periodStart.toISOString()).toBe("2026-06-18T00:00:00.000Z"); // floored
    expect(summary.periodEnd.toISOString()).toBe("2026-07-18T09:00:00.000Z"); // raw
    expect(summary.events).toBe(115); // 10 + 40 + 60 rolled + 5 live; the pre-cycle 999 is excluded
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

  it("shows a rowless (Free) org the injected default cap it is enforced at, not 'uncapped' (S4.3b)", async () => {
    // A Free org has NO org_limits row but IS enforced at FREE_EVENT_CAP by the producer — the surface must
    // reflect that same cap (display == enforcement), never a bare uncapped while it would be paused at it.
    const orgId = await seedOrg("usage-free-default");
    const summary = await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW, 500));
    expect(summary.eventCap).toBe(500);
    expect(summary.pausePolicy).toBe("pause"); // Free default
  });

  it("lets an explicit org_limits row WIN over the injected default (cap and explicit-null uncapped)", async () => {
    const capped = await seedOrg("usage-explicit-cap");
    await withTenant(
      app,
      capped,
      (tx) => tx`insert into org_limits (org_id, event_cap) values (${capped}, ${999})`,
    );
    expect((await withTenant(app, capped, (tx) => readUsageSummary(tx, NOW, 500))).eventCap).toBe(
      999,
    );

    // An explicit row with a NULL event_cap = deliberately uncapped — the default must NOT override it.
    // Write the SQL NULL literal directly (not an interpolated `${null}`) so the intent is explicit.
    const uncapped = await seedOrg("usage-explicit-null");
    await withTenant(
      app,
      uncapped,
      (tx) => tx`insert into org_limits (org_id, event_cap) values (${uncapped}, NULL)`,
    );
    expect(
      (await withTenant(app, uncapped, (tx) => readUsageSummary(tx, NOW, 500))).eventCap,
    ).toBeNull();
  });

  it("defaults to uncapped when no default cap is passed (unset FREE_EVENT_CAP = fail-safe)", async () => {
    const orgId = await seedOrg("usage-no-default");
    // No third arg → defaultEventCap null → a rowless org is uncapped (the dark/fail-safe default).
    expect((await withTenant(app, orgId, (tx) => readUsageSummary(tx, NOW))).eventCap).toBeNull();
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
