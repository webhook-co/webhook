import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { evaluateOrgCap, makeCapTransitionEvictor, runCapProducer } from "../src/cap-producer";
import { createClient, withTenant, type Sql } from "../src/client";
import type { UsageThresholdContext } from "../src/delivery";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The soft-cap producer: per-org, compare current-period usage to the effective cap and flip
// ingest_paused ONLY on a transition, firing edge eviction. Free (no org_limits row) uses the injected
// default cap; a row uses its own cap/policy; 'allow' never pauses; resume clears the pause.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → period [2026-07-01, 2026-08-01)
const IN_PERIOD = "2026-07-10T00:00:00.000Z";
const DEFAULT_CAP = 100; // injected Free default (test value; never hardcoded in source)

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;
let admin: Sql; // superuser (bypasses RLS) — for cross-org cleanup between tests

/** `created_at` anchors a Free org's LIFETIME allowance window — default it before every seeded fixture date
 *  (in prod an org's events can never predate it; the DB default `now()` is the real clock, not our fake NOW). */
const ORG_CREATED = "2026-01-01T00:00:00.000Z";
async function seedOrg(slug: string, createdAt = ORG_CREATED): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at) values (${orgId}, ${slug}, ${slug}, ${createdAt})`;
  });
  return orgId;
}

async function seedUsage(orgId: string, count: number): Promise<void> {
  await seedUsageAt(orgId, IN_PERIOD, count);
}

async function seedUsageAt(orgId: string, windowIso: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${windowIso}, ${count})`;
  });
}

// Seed `n` raw events on NOW's UTC day (today), so the producer's LIVE today-count picks them up.
// received_at is trigger-stamped to now() on INSERT, so UPDATE it to a today instant after.
async function seedEventsToday(orgId: string, n: number): Promise<void> {
  const endpointId = randomUUID();
  const at = "2026-07-15T06:00:00.000Z"; // within NOW's day (2026-07-15)
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

async function pausedState(
  orgId: string,
): Promise<{ paused: boolean; reason: string | null } | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ paused: boolean; reason: string | null }[]>`
      select paused, reason from ingest_paused where org_id = ${orgId}`;
    return row ?? null;
  });
}

interface RunOpts {
  onTransition?: (orgId: string, paused: boolean) => Promise<void>;
  log?: (m: string, f?: Record<string, unknown>) => void;
  limit?: number;
  defaultEventCap?: number | null;
  now?: number;
}
async function run(opts: RunOpts = {}) {
  return runCapProducer({
    meter,
    app,
    now: opts.now ?? NOW,
    defaultEventCap: opts.defaultEventCap === undefined ? DEFAULT_CAP : opts.defaultEventCap,
    limit: opts.limit ?? 1000,
    onTransition: opts.onTransition,
    log: opts.log,
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
  admin = createClient(pg.providerUrl); // the postgres superuser — bypasses RLS for cleanup
}, setupHookTimeoutMs());

// Per-test isolation: runCapProducer enumerates ALL orgs cross-tenant, so state seeded by one test
// would otherwise perturb another's global transition counts. Clear the mutable tables before each test
// (as owner, bypassing RLS) so every test starts clean and its counters are exact. DELETE (not TRUNCATE
// CASCADE) — cascade would hit audit_log's append-only guard; child→parent order respects the FKs.
beforeEach(async () => {
  await admin`delete from notification_intents`;
  await admin`delete from usage_alerts`;
  await admin`delete from events`;
  await admin`delete from usage`;
  await admin`delete from ingest_paused`;
  await admin`delete from org_limits`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from endpoints`;
  await admin`delete from orgs`;
});

/** Seed a paid org's subscription (SELECT-only for webhook_app → as owner). */
async function seedSubscription(
  orgId: string,
  opts: { status?: string; start: string; end: string },
): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 6)}, ${"pro"}, ${opts.status ?? "active"},
            ${opts.start}, ${opts.end})`;
}

/** Count the usage_threshold notification intents queued for an org (as owner, bypassing RLS). */
async function usageAlertIntents(
  orgId: string,
): Promise<Array<{ threshold: number; usage: number }>> {
  const rows = await admin<{ context: { threshold: number; usage: number } }[]>`
    select context from notification_intents
    where org_id = ${orgId} and kind = 'usage_threshold' order by (context->>'threshold')::int`;
  return rows.map((r) => ({ threshold: r.context.threshold, usage: r.context.usage }));
}

/** The FULL stored intent context — the exact JSON the notify-cron drain hands to the email renderer.
 *  The renderer branches on `capKind`, so a snapshot that silently drops it would render a Free org a
 *  billing-cycle email promising a reset date that will never come. Pin the whole shape, not just the
 *  two fields the pause assertions read. */
async function usageAlertContexts(orgId: string): Promise<UsageThresholdContext[]> {
  const rows = await admin<{ context: UsageThresholdContext }[]>`
    select context from notification_intents
    where org_id = ${orgId} and kind = 'usage_threshold' order by (context->>'threshold')::int`;
  return rows.map((r) => r.context);
}

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await admin?.end();
  await pg?.stop();
});

describe("runCapProducer", () => {
  it("pauses a Free org (no org_limits row) once it crosses the injected default cap", async () => {
    const orgId = await seedOrg("cap-free-over");
    await seedUsage(orgId, 150); // > DEFAULT_CAP (100)
    const evicted: Array<{ orgId: string; paused: boolean }> = [];

    const result = await run({
      onTransition: async (o, p) => void evicted.push({ orgId: o, paused: p }),
    });

    expect(result.pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
    expect(evicted).toContainEqual({ orgId, paused: true });
  });

  it("reports capped=false on a normal pass and capped=true when the enumeration hits the limit", async () => {
    // A pass under the limit is not truncated.
    const under = await run({ limit: 1000 });
    expect(under.capped).toBe(false);
    // Force truncation: two candidate orgs (org_limits rows) with limit 1 → capped, tail deferred.
    await seedOrg("cap-trunc-a").then((o) =>
      withTenant(
        app,
        o,
        (tx) => tx`insert into org_limits (org_id, event_cap) values (${o}, ${100})`,
      ),
    );
    await seedOrg("cap-trunc-b").then((o) =>
      withTenant(
        app,
        o,
        (tx) => tx`insert into org_limits (org_id, event_cap) values (${o}, ${100})`,
      ),
    );
    const capped = await run({ limit: 1 });
    expect(capped.capped).toBe(true);
    expect(capped.orgsProcessed).toBe(1);
  });

  it("does not pause a Free org under the default cap (no ingest_paused row created)", async () => {
    const orgId = await seedOrg("cap-free-under");
    await seedUsage(orgId, 50);
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("NEVER pauses a Free org when the default cap is null (FREE_EVENT_CAP unset/invalid = uncapped)", async () => {
    // The fail-safe: a huge-usage Free org with no injected cap must not pause. A regression here would
    // mass-pause every Free org whenever FREE_EVENT_CAP is unset — the exact outage the guard prevents.
    const orgId = await seedOrg("cap-free-uncapped");
    await seedUsage(orgId, 10_000_000); // >> any tier cap
    const evicted: string[] = [];
    const result = await run({
      defaultEventCap: null,
      onTransition: async (o) => void evicted.push(o),
    });
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
    expect(evicted).toEqual([]); // no transition → no eviction
  });

  it("counts TODAY's live events toward the cap, not just rolled usage (prior 99 + 7 live = 106 > 100)", async () => {
    // Enforcement uses the SAME rolled-prior + live-today basis the surface shows. Rolled alone (99) is
    // under the cap; only WITH today's 7 live events does the org cross it — proving live events enforce.
    const orgId = await seedOrg("cap-live-today");
    await seedUsage(orgId, 99); // prior day, rolled — under the cap by itself
    await seedEventsToday(orgId, 7); // today, live — pushes it to 106
    const result = await run(); // default cap 100
    expect(result.pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("does not WRONGFULLY RESUME a paused org still over cap via today's live events", async () => {
    // A paused org at 99 rolled + 7 live = 106 (> cap 100) must STAY paused. If enforcement ignored the
    // live today-count it would see only 99, resume, and re-open capture over the cap.
    const orgId = await seedOrg("cap-no-wrong-resume");
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into ingest_paused (org_id, paused, reason, since) values (${orgId}, ${true}, ${"cap"}, now())`;
    });
    await seedUsage(orgId, 99);
    await seedEventsToday(orgId, 7);
    const result = await run();
    expect(result.resumedTransitions).toBe(0);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("never DOUBLE-COUNTS a rolled TODAY usage row against the live today-count", async () => {
    // 50 prior rolled + a today `usage` row of 99 (the rollup already ran today) + 4 live events today.
    // Correct usage = 50 + 4 = 54 (the today-rolled 99 is excluded in favor of the live count) < cap 100
    // → NO pause. A double-count (50 + 99 + 4 = 153) would pause — this pins that it doesn't.
    const orgId = await seedOrg("cap-no-double");
    await seedUsage(orgId, 50); // prior day (07-10), rolled
    await seedUsageAt(orgId, "2026-07-15T00:00:00.000Z", 99); // TODAY rolled row — must be ignored
    await seedEventsToday(orgId, 4); // today live — the authoritative today figure
    const result = await run(); // default cap 100
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("respects an explicit org_limits cap over the default", async () => {
    const orgId = await seedOrg("cap-explicit");
    await seedUsage(orgId, 500); // over the default (100) but under the org's own cap
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000000}, ${"pause"})`;
    });
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("never pauses under the 'allow' policy even over the cap", async () => {
    const orgId = await seedOrg("cap-allow");
    await seedUsage(orgId, 999);
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"allow"})`;
    });
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("resumes a paused org that is now under cap (new period / raised cap), firing eviction", async () => {
    const orgId = await seedOrg("cap-resume");
    // Pre-existing pause, but no usage this period (a fresh period) → should resume.
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into ingest_paused (org_id, paused, reason, since) values (${orgId}, ${true}, ${"cap"}, now())`;
    });
    const evicted: Array<{ orgId: string; paused: boolean }> = [];
    const result = await run({
      onTransition: async (o, p) => void evicted.push({ orgId: o, paused: p }),
    });
    expect(result.resumedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: false, reason: null });
    expect(evicted).toContainEqual({ orgId, paused: false });
  });

  it("is idempotent — no transition (or eviction) when already in the desired state", async () => {
    const orgId = await seedOrg("cap-idempotent");
    await seedUsage(orgId, 150);
    await run(); // first pass pauses
    const evicted: string[] = [];
    const result = await run({ onTransition: async (o) => void evicted.push(o) });
    expect(result.pausedTransitions).toBe(0);
    expect(result.resumedTransitions).toBe(0);
    expect(evicted).toEqual([]);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("isolates a failing eviction — the transition still commits, the pass continues", async () => {
    const orgId = await seedOrg("cap-evict-throw");
    await seedUsage(orgId, 150);
    const logs: string[] = [];
    const result = await run({
      onTransition: async () => {
        throw new Error("KV blip");
      },
      log: (m) => logs.push(m),
    });
    expect(result.pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" }); // durable write survived
    expect(logs).toContain("metering.cap.evict_failed");
  });

  describe("usage-threshold alerts (S4.3b warn-before-pause)", () => {
    it("emits an 80% alert for a capped org approaching its cap — with NO pause transition", async () => {
      // 80 of DEFAULT_CAP (100) = 80% → crosses 80, NOT 100. It is NOT paused (80 < 100) — this pins that
      // the alert fires even when want === current === false (the early-return-before-emit bug this guards).
      const orgId = await seedOrg("alert-approaching");
      await seedUsage(orgId, 80);
      const result = await run();
      expect(result.thresholdAlerts).toBe(1);
      expect(result.pausedTransitions).toBe(0);
      expect(await pausedState(orgId)).toBeNull();
      expect(await usageAlertIntents(orgId)).toEqual([{ threshold: 80, usage: 80 }]);
    });

    it("emits BOTH 80% and 100% when an org lands at/over its cap in one pass (and pauses)", async () => {
      const orgId = await seedOrg("alert-at-cap");
      await seedUsage(orgId, 100); // 100% of DEFAULT_CAP
      const result = await run();
      expect(result.thresholdAlerts).toBe(2);
      expect(result.pausedTransitions).toBe(1); // 100% is also the pause point
      expect(await usageAlertIntents(orgId)).toEqual([
        { threshold: 80, usage: 100 },
        { threshold: 100, usage: 100 },
      ]);
    });

    it("is idempotent per period — a second pass emits no duplicate alert", async () => {
      const orgId = await seedOrg("alert-dedup");
      await seedUsage(orgId, 90);
      const first = await run();
      expect(first.thresholdAlerts).toBe(1);
      const second = await run();
      expect(second.thresholdAlerts).toBe(0); // usage_alerts dedup — already alerted this period
      expect(await usageAlertIntents(orgId)).toHaveLength(1); // still just the one intent
    });

    it("emits threshold alerts for an 'allow' org too (over cap but never paused)", async () => {
      const orgId = await seedOrg("alert-allow");
      await seedUsage(orgId, 100);
      await withTenant(app, orgId, async (tx) => {
        await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"allow"})`;
      });
      const result = await run();
      expect(result.thresholdAlerts).toBe(2);
      expect(result.pausedTransitions).toBe(0); // allow never pauses
      expect(await pausedState(orgId)).toBeNull();
    });

    it("emits NO threshold alert for an uncapped org (can't be a % of uncapped)", async () => {
      const orgId = await seedOrg("alert-uncapped");
      await seedUsage(orgId, 10_000_000);
      const result = await run({ defaultEventCap: null }); // no cap → no percentage → no alert
      expect(result.thresholdAlerts).toBe(0);
      expect(await usageAlertIntents(orgId)).toEqual([]);
    });

    it("emits the 100% alert on a LATER pass once usage climbs past it (80% already deduped)", async () => {
      // Incremental crossing across passes: 80% now, then 100% next pass. The 80 row is already there
      // (deduped), so only the 100 intent is newly enqueued — no re-80.
      const orgId = await seedOrg("alert-incremental");
      await seedUsageAt(orgId, "2026-07-10T00:00:00.000Z", 80); // 80% of 100
      const first = await run();
      expect(first.thresholdAlerts).toBe(1);
      await seedUsageAt(orgId, "2026-07-11T00:00:00.000Z", 20); // → 100 total in the July period
      const second = await run();
      expect(second.thresholdAlerts).toBe(1); // only 100; 80 already deduped
      expect(await usageAlertIntents(orgId)).toEqual([
        { threshold: 80, usage: 80 },
        { threshold: 100, usage: 100 },
      ]);
    });

    it("a FREE org's LIFETIME allowance alerts ONCE EVER — a new month never re-arms it", async () => {
      // The lifetime period_start is the org's creation instant, so it never changes: the usage_alerts PK
      // (org, period_start, threshold) dedups a one-time allowance's warning FOREVER. A one-time allowance
      // has no reset, so re-arming the email each month would be a lie.
      const AUG = Date.UTC(2026, 7, 15, 12, 0, 0);
      const orgId = await seedOrg("alert-lifetime");
      await seedUsageAt(orgId, "2026-07-10T00:00:00.000Z", 90); // 90 of the 100 cap → crosses 80%
      expect((await run()).thresholdAlerts).toBe(1);
      // The stored snapshot is what the notify-cron drain hands the email renderer. `capKind: "lifetime"`
      // + a null periodEndIso are load-bearing: without them the renderer promises a reset that never comes.
      expect(await usageAlertContexts(orgId)).toEqual([
        {
          threshold: 80,
          usage: 90,
          eventCap: 100,
          pausePolicy: "pause",
          capKind: "lifetime",
          periodEndIso: null,
        },
      ]);
      expect((await run()).thresholdAlerts).toBe(0); // same lifetime period → deduped
      expect((await run({ now: AUG })).thresholdAlerts).toBe(0); // a new MONTH does not re-arm it
      const [{ n }] = await admin<{ n: number }[]>`
        select count(*)::int as n from usage_alerts where org_id = ${orgId} and threshold = 80`;
      expect(n).toBe(1); // exactly one 80% alert, ever
    });

    it("a PAID org re-alerts when its billing CYCLE advances (per-cycle dedup, not permanent)", async () => {
      // A paid plan's allowance DOES reset each cycle, so a fresh period_start must re-arm the warning.
      const AUG = Date.UTC(2026, 7, 15, 12, 0, 0);
      const orgId = await seedOrg("alert-new-cycle");
      await seedSubscription(orgId, { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" });
      await seedUsageAt(orgId, "2026-07-10T00:00:00.000Z", 90); // 80% of the 100 cap
      expect((await run()).thresholdAlerts).toBe(1); // July cycle
      // The mirror image of the lifetime snapshot: a paid cycle carries capKind 'billing_cycle' and the
      // subscription's real end instant, so the renderer prints an honest reset date.
      expect(await usageAlertContexts(orgId)).toEqual([
        {
          threshold: 80,
          usage: 90,
          eventCap: 100,
          pausePolicy: "pause",
          capKind: "billing_cycle",
          periodEndIso: "2026-08-01T00:00:00.000Z",
        },
      ]);
      expect((await run()).thresholdAlerts).toBe(0); // same cycle → deduped

      // Renewal: the cycle advances. July's usage falls outside it; August's 90 crosses 80% afresh.
      await admin`update billing_subscriptions
                  set current_period_start = ${"2026-08-01T00:00:00Z"},
                      current_period_end = ${"2026-09-01T00:00:00Z"}
                  where org_id = ${orgId}`;
      await seedUsageAt(orgId, "2026-08-10T00:00:00.000Z", 90);
      expect((await run({ now: AUG })).thresholdAlerts).toBe(1); // new cycle → fresh alert
      const [{ n }] = await admin<{ n: number }[]>`
        select count(*)::int as n from usage_alerts where org_id = ${orgId} and threshold = 80`;
      expect(n).toBe(2); // (July cycle, 80) and (August cycle, 80)
    });
  });

  describe("subscription-period-aware enforcement", () => {
    it("enumerates + PAUSES a paid org whose over-cap usage sits in its cycle's PRIOR-month portion", async () => {
      // The org's Stripe cycle is 2026-06-18 → 2026-07-18 (straddles the month), with over-cap usage in
      // JUNE — the prior UTC month, so the usage/org_limits/ingest_paused enumeration floors would MISS it.
      // It's a paid subscription with NO org_limits row (fail-closed cap), enforced at the Free default.
      // The billing_subscriptions enumeration union must still find it, and the effective period (its Stripe
      // cycle) must count the June usage → over the Free cap → pause.
      const orgId = await seedOrg("paid-prior-month");
      await seedSubscription(orgId, { start: "2026-06-18T00:00:00Z", end: "2026-07-18T00:00:00Z" });
      await seedUsageAt(orgId, "2026-06-20T00:00:00.000Z", 150); // in-cycle, prior UTC month, > Free cap 100

      const res = await run({ defaultEventCap: DEFAULT_CAP }); // Free default = 100
      expect(res.pausedTransitions).toBe(1);
      expect((await pausedState(orgId))?.paused).toBe(true);
    });

    it("a FREE org over its LIFETIME allowance is paused as soon as it is enumerated (lazy pause)", async () => {
      // The Free allowance is lifetime, so June usage still counts against it. But the producer's candidate
      // floor is the current UTC month: an org with NO current-month usage (and no pause/limits/subscription
      // row) isn't enumerated at all, so it isn't paused while it's idle. The moment it sends again this
      // month it becomes a candidate and the lifetime total (150 > 100) pauses it. Bounded, self-correcting.
      const orgId = await seedOrg("free-lifetime-lazy");
      await seedUsageAt(orgId, "2026-06-20T00:00:00.000Z", 150); // June only → over the 100 lifetime cap
      expect((await run({ defaultEventCap: DEFAULT_CAP })).pausedTransitions).toBe(0); // idle → not enumerated
      expect(await pausedState(orgId)).toBeNull();

      await seedUsageAt(orgId, "2026-07-03T00:00:00.000Z", 1); // it sends again → now a candidate
      expect((await run({ defaultEventCap: DEFAULT_CAP })).pausedTransitions).toBe(1);
      expect((await pausedState(orgId))?.paused).toBe(true); // lifetime 151 > 100 → paused
    });

    it("a LAPSED cycle falls back to the UTC month — NOT paused over stale prior-cycle usage", async () => {
      // The subscription's cycle ENDED 2026-07-05, before NOW (2026-07-15) — a late/missing renewal webhook.
      // Its over-cap usage is in the lapsed cycle (June). effectiveBillingPeriod must fall back to the UTC
      // month (July, usage = 0), so the org is NOT stranded paused over the stale/ended window.
      const orgId = await seedOrg("paid-lapsed");
      await seedSubscription(orgId, { start: "2026-06-05T00:00:00Z", end: "2026-07-05T00:00:00Z" }); // end < NOW
      await seedUsageAt(orgId, "2026-06-20T00:00:00.000Z", 150); // in the lapsed cycle, > Free cap
      const res = await run({ defaultEventCap: DEFAULT_CAP });
      expect(res.pausedTransitions).toBe(0);
      expect(await pausedState(orgId)).toBeNull();
    });

    it("RESUMES an org stranded paused from a lapsed cycle (the fallback un-pauses it)", async () => {
      // An org already PAUSED (from its prior cycle being over cap) whose cycle has now lapsed. The UTC-month
      // fallback sees no current-month usage → under cap → the producer must RESUME it (un-pause), not leave
      // a paying customer stranded paused into the fresh cycle.
      const orgId = await seedOrg("paid-lapsed-paused");
      await seedSubscription(orgId, { start: "2026-06-05T00:00:00Z", end: "2026-07-05T00:00:00Z" }); // lapsed
      await seedUsageAt(orgId, "2026-06-20T00:00:00.000Z", 150); // stale over-cap usage in the lapsed cycle
      await admin`insert into ingest_paused (org_id, paused, reason, since)
                  values (${orgId}, ${true}, ${"cap"}, now())`; // pre-paused

      const res = await run({ defaultEventCap: DEFAULT_CAP });
      expect(res.resumedTransitions).toBe(1);
      expect(await pausedState(orgId)).toEqual({ paused: false, reason: null });
    });
  });
});

describe("makeCapTransitionEvictor (the onTransition edge-eviction fan-out)", () => {
  async function seedEndpoint(orgId: string, name: string, deleted = false): Promise<Uint8Array> {
    const hash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); // 64 hex chars
    const bytes = Buffer.from(hash, "hex"); // 32-byte token hash
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into endpoints (id, org_id, ingest_token_hash, name, deleted_at)
               values (${randomUUID()}, ${orgId}, ${bytes}, ${name}, ${deleted ? new Date().toISOString() : null})`;
    });
    return new Uint8Array(bytes);
  }

  it("evicts EVERY live endpoint's ingest-token hash for the org, skipping soft-deleted ones", async () => {
    const orgId = await seedOrg("evict-fanout");
    const h1 = await seedEndpoint(orgId, "ep-1");
    const h2 = await seedEndpoint(orgId, "ep-2");
    await seedEndpoint(orgId, "ep-deleted", true); // must NOT be evicted

    const evicted: string[] = [];
    const evict = async (h: Uint8Array) => void evicted.push(Buffer.from(h).toString("hex"));
    const onTransition = makeCapTransitionEvictor(app, evict);
    await onTransition(orgId);

    const hex = (h: Uint8Array) => Buffer.from(h).toString("hex");
    expect(evicted.sort()).toEqual([hex(h1), hex(h2)].sort());
    expect(evicted).toHaveLength(2); // the deleted endpoint's hash is excluded
  });

  it("is RLS-scoped — evicts only the target org's endpoints, never another org's", async () => {
    const a = await seedOrg("evict-iso-a");
    const b = await seedOrg("evict-iso-b");
    const ha = await seedEndpoint(a, "a-ep");
    await seedEndpoint(b, "b-ep");

    const evicted: string[] = [];
    await makeCapTransitionEvictor(
      app,
      async (h) => void evicted.push(Buffer.from(h).toString("hex")),
    )(a);
    expect(evicted).toEqual([Buffer.from(ha).toString("hex")]);
  });
});

describe("the churn ↔ upgrade round trip (the lifetime allowance's escape hatch)", () => {
  it("a Free org exhausted on its LIFETIME allowance RESUMES when it upgrades", async () => {
    // The claim the lifetime basis rests on: the one-time allowance never resets, so the ONLY way out is to
    // subscribe. Upgrading re-anchors the org to a fresh Stripe cycle whose usage is ~0, and the very next
    // producer pass must resume it — AND fire edge eviction, or a paying customer keeps getting 429s until
    // the ingest-token cache TTL expires.
    const orgId = await seedOrg("lifetime-upgrade");
    await seedUsageAt(orgId, "2026-07-10T00:00:00.000Z", 150); // 150 > the 100 free cap → over, lifetime
    expect((await run()).pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });

    // Upgrade: an ENTITLED subscription whose cycle starts AFTER the pre-upgrade usage, plus its paid cap.
    await seedSubscription(orgId, { start: "2026-07-14T00:00:00Z", end: "2026-08-14T00:00:00Z" });
    await admin`insert into org_limits (org_id, event_cap) values (${orgId}, ${1_000_000})`;

    const evicted: Array<{ orgId: string; paused: boolean }> = [];
    const result = await run({
      onTransition: async (o, p) => void evicted.push({ orgId: o, paused: p }),
    });
    expect(result.resumedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: false, reason: null });
    expect(evicted).toContainEqual({ orgId, paused: false }); // no 429 tail for a paying customer
  });

  it("a paused Free org does NOT resume merely because a new UTC month began", async () => {
    // The negative that makes the allowance one-time. The org is enumerated (its ingest_paused row is a
    // candidate floor), re-evaluated on the lifetime basis, and stays paused — no calendar reset.
    const AUG = Date.UTC(2026, 7, 15, 12, 0, 0);
    const orgId = await seedOrg("lifetime-no-rollover");
    await seedUsageAt(orgId, "2026-07-10T00:00:00.000Z", 150);
    expect((await run()).pausedTransitions).toBe(1);
    const result = await run({ now: AUG }); // a whole new month, no new events
    expect(result.resumedTransitions).toBe(0);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });
});

// evaluateOrgCap — the single-org core shared by the cron AND the WS3 overage-toggle RPC. It must flip
// ingest_paused immediately when the effective pause decision changes (e.g. the user just flipped the
// pause_policy), on the exact same basis the cron uses, so the toggle takes effect without a cron wait.
describe("evaluateOrgCap (single-org core for the overage toggle)", () => {
  const evalOrg = (orgId: string, defaultEventCap: number | null = DEFAULT_CAP, now = NOW) =>
    withTenant(app, orgId, (tx) => evaluateOrgCap(tx, { orgId, now, defaultEventCap }));

  it("pauses an over-cap org whose policy is 'pause' (transition true, ingest_paused set)", async () => {
    const orgId = await seedOrg("eval-pause");
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"pause"})`,
    );
    await seedUsage(orgId, 150);
    const r = await evalOrg(orgId);
    expect(r).toMatchObject({
      transition: true,
      paused: true,
      eventCap: 100,
      pausePolicy: "pause",
    });
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("RESUMES an over-cap PAUSED org the moment its policy flips to 'allow' (the overage-ON toggle)", async () => {
    const orgId = await seedOrg("eval-allow-resume");
    await seedUsage(orgId, 150);
    // Start over-cap on 'pause' → paused.
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"pause"})`,
    );
    expect((await evalOrg(orgId)).paused).toBe(true);
    // User enables overage → policy 'allow'. Re-evaluating must RESUME immediately (no cron wait).
    await withTenant(app, orgId, (tx) => tx`update org_limits set pause_policy = ${"allow"}`);
    const r = await evalOrg(orgId);
    expect(r).toMatchObject({ transition: false, paused: false, pausePolicy: "allow" });
    expect(await pausedState(orgId)).toEqual({ paused: false, reason: null });
  });

  it("PAUSES an over-cap unpaused org the moment its policy flips to 'pause' (the overage-OFF toggle)", async () => {
    const orgId = await seedOrg("eval-pause-toggle");
    await seedUsage(orgId, 150);
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"allow"})`,
    );
    expect((await evalOrg(orgId)).paused).toBe(false); // 'allow' never pauses
    await withTenant(app, orgId, (tx) => tx`update org_limits set pause_policy = ${"pause"}`);
    const r = await evalOrg(orgId);
    expect(r).toMatchObject({ transition: true, paused: true });
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("is idempotent — re-evaluating a settled state does NOT write a transition", async () => {
    const orgId = await seedOrg("eval-idempotent");
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"pause"})`,
    );
    await seedUsage(orgId, 150);
    expect((await evalOrg(orgId)).transition).toBe(true); // first flip
    expect((await evalOrg(orgId)).transition).toBeNull(); // already paused → no-op
  });

  it("an UNDER-cap org never pauses, whatever the policy", async () => {
    const orgId = await seedOrg("eval-under");
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000}, ${"pause"})`,
    );
    await seedUsage(orgId, 10);
    const r = await evalOrg(orgId);
    expect(r).toMatchObject({ transition: null, paused: false });
    expect(await pausedState(orgId)).toBeNull();
  });
});
