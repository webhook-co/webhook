import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readActivationWeeklyReview } from "../src/activation-review";
import { runActivationRollup } from "../src/activation-rollup";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Activation instrumentation (marketing measurement layer). The north-star — "weekly activated
// developers" — is DERIVED off the hot path from tables the product already writes: first-capture from
// events.received_at, first-forward from delivery_attempts.status='forwarded' (uniquely the localhost
// tunnel writer). Two SECURITY INVOKER rollup fns run per-tenant under webhook_app RLS (mirroring
// rollup_delivery_stats); one SECURITY DEFINER fn (mirroring user_org_directory, 0067) reads the three
// activation tables cross-org — via `to webhook_owner using(true)` policies, so the definer is POLICED,
// not bypassing RLS — and returns AGGREGATES ONLY (no org_id, no PII). This suite asserts real rows, and
// the set-once / OR-accumulate durability cases PRUNE the source rows so LEAST/OR are load-bearing (a plain
// overwrite would fail them) — matching how retention actually purges events/delivery_attempts in prod.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** ISO-week Monday (UTC midnight) `weeksAgo` before the fixture week, as a YYYY-MM-DD date string.
 *  2026-07-06 is the Monday anchoring the fixtures' "current" ISO week. */
function isoWeek(weeksAgo: number): string {
  const monday = Date.UTC(2026, 6, 6) - weeksAgo * WEEK_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

let pg: EphemeralPostgres;
let app: Sql;
// The least-privilege webhook_meter connection — cross-org org enumeration for the rollup driver (the exact
// role + column grants the cron uses in prod).
let meter: Sql;
// The provider (RLS-bypassing) connection — the harness handle for cross-org ops writes/reads: seeding the
// owner-managed metric-exclusions list and simulating retention prunes.
let provider: Sql;
// The PRODUCTION caller: the least-privilege webhook_activation_reviewer connection, which is exactly what
// `GET /v1/internal/activation/weekly` opens over its Hyperdrive. 0092 revokes EXECUTE from PUBLIC and 0093
// grants it back to this one role, so the ACL is {owner, reviewer} — and the Neon provider role is in
// NEITHER (#717). Reading through the real role is the only thing that proves the prod path works: until
// 0093 the role existed solely by hand in production, so nothing here exercised it (#721).
let reviewer: Sql;

/** Seed an org (with an explicit created_at = signup time) + one endpoint + optionally one event at
 *  `eventAtMs`. received_at is trigger-stamped to now() on INSERT (events_received_at_biu), so the fixture
 *  instant is set with a follow-up UPDATE — the pattern the metering/usage tests use. */
async function seedOrg(
  slug: string,
  createdAtMs: number,
  eventAtMs: number | null = null,
): Promise<{ orgId: string; endpointId: string; eventId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  const eventId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at)
             values (${orgId}, ${slug}, ${slug}, ${new Date(createdAtMs).toISOString()})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    if (eventAtMs !== null) {
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${eventId}, ${orgId}, ${endpointId}, ${slug + "-p"}, ${10}, ${slug + "-dk"}, ${"content_hash"})`;
      await tx`update events set received_at = ${new Date(eventAtMs).toISOString()} where id = ${eventId}`;
    }
  });
  return { orgId, endpointId, eventId };
}

/** Seed one event for an org at a specific time (a distinct dedup_key so it always inserts). */
async function seedEvent(
  orgId: string,
  endpointId: string,
  atMs: number,
  tag: string,
): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    const id = randomUUID();
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${id}, ${orgId}, ${endpointId}, ${tag + "-p"}, ${10}, ${tag}, ${"content_hash"})`;
    await tx`update events set received_at = ${new Date(atMs).toISOString()} where id = ${id}`;
  });
}

/** Seed one delivery_attempts row with the given status + created_at. */
async function seedDelivery(
  orgId: string,
  eventId: string,
  status: string,
  atMs: number,
): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status, attempt, created_at, billable)
             values (${randomUUID()}, ${orgId}, ${eventId}, ${"http://localhost:3000/hook"}, ${status}, ${1}, ${new Date(atMs).toISOString()}, ${false})`;
  });
}

/** Simulate retention: hard-delete an event (RLS-bypassing, like the prune cron). */
async function pruneEvent(id: string): Promise<void> {
  await provider`delete from delivery_attempts where event_id = ${id}`;
  await provider`delete from events where id = ${id}`;
}

/** Simulate retention: hard-delete an org's forward delivery rows, keeping its capture events. */
async function pruneForwards(orgId: string): Promise<void> {
  await provider`delete from delivery_attempts where org_id = ${orgId} and status = 'forwarded'`;
}

/** Run both rollup functions for one org. Milestones scan all retained rows (set-once, backfill-safe);
 *  weekly is re-rolled across a settle window (here weeks 0..3 back, covering every fixture's activity). */
async function rollupOrg(orgId: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`select rollup_activation_milestones()`;
    for (const w of [0, 1, 2, 3]) {
      await tx`select rollup_activation_weekly(${isoWeek(w)}::date)`;
    }
  });
}

async function milestonesOf(orgId: string): Promise<{
  signed_up_at: Date;
  first_capture_at: Date | null;
  first_forward_at: Date | null;
} | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<
      { signed_up_at: Date; first_capture_at: Date | null; first_forward_at: Date | null }[]
    >`select signed_up_at, first_capture_at, first_forward_at
      from activation_org_milestones where org_id = ${orgId}`;
    return row ?? null;
  });
}

async function weeklyOf(
  orgId: string,
  week: string,
): Promise<{ captured: boolean; forwarded: boolean } | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ captured: boolean; forwarded: boolean }[]>`
      select captured, forwarded from activation_org_weekly
      where org_id = ${orgId} and iso_week = ${week}::date`;
    return row ?? null;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
  provider = createClient(pg.providerUrl);
  reviewer = createClient(pg.urlFor({ role: DB_ROLES.activationReviewer }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await provider?.end();
  await reviewer?.end();
  await pg?.stop();
});

describe("rollup_activation_milestones", () => {
  it("derives first-capture (MIN received_at) and first-forward (MIN forwarded), signup from orgs.created_at", async () => {
    const signup = Date.UTC(2026, 6, 6, 9); // Mon of this week
    const cap1 = Date.UTC(2026, 6, 6, 10);
    const cap2 = Date.UTC(2026, 6, 7, 10); // later capture — must NOT lower the min
    const fwd = Date.UTC(2026, 6, 7, 11);
    const { orgId, endpointId, eventId } = await seedOrg("act-a", signup, cap1);
    await seedEvent(orgId, endpointId, cap2, "act-a-2");
    await seedDelivery(orgId, eventId, "forwarded", fwd);
    // An automated delivery (delivered) EARLIER than the forward — must NOT count as first-forward.
    await seedDelivery(orgId, eventId, "delivered", Date.UTC(2026, 6, 6, 8));

    await rollupOrg(orgId);

    const m = await milestonesOf(orgId);
    expect(m?.signed_up_at.toISOString()).toBe(new Date(signup).toISOString());
    expect(m?.first_capture_at?.toISOString()).toBe(new Date(cap1).toISOString());
    expect(m?.first_forward_at?.toISOString()).toBe(new Date(fwd).toISOString());
  });

  it("is set-once via LEAST: the milestone survives even after its source event is PRUNED", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const firstCap = Date.UTC(2026, 6, 6, 12);
    const { orgId, endpointId, eventId } = await seedOrg("act-mono", signup, firstCap);
    await rollupOrg(orgId);
    expect((await milestonesOf(orgId))?.first_capture_at?.toISOString()).toBe(
      new Date(firstCap).toISOString(),
    );

    // Retention prunes the earliest event and only a LATER event remains. The recomputed MIN is now later,
    // so a plain overwrite would REGRESS first_capture_at forward — LEAST must keep the stored (earlier)
    // value. This is the load-bearing set-once case.
    await pruneEvent(eventId);
    await seedEvent(orgId, endpointId, Date.UTC(2026, 6, 8, 9), "act-mono-2");
    await rollupOrg(orgId);
    expect((await milestonesOf(orgId))?.first_capture_at?.toISOString()).toBe(
      new Date(firstCap).toISOString(),
    );
  });

  it("leaves first_forward_at null for an org that captured but never forwarded", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const { orgId, eventId } = await seedOrg("act-noforward", signup, Date.UTC(2026, 6, 6, 10));
    await seedDelivery(orgId, eventId, "delivered", Date.UTC(2026, 6, 6, 11)); // automated, not a forward
    await rollupOrg(orgId);
    const m = await milestonesOf(orgId);
    expect(m?.first_capture_at).not.toBeNull();
    expect(m?.first_forward_at).toBeNull();
  });
});

describe("rollup_activation_weekly", () => {
  it("flags captured/forwarded per ISO week, isolated per org", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const { orgId, eventId } = await seedOrg("act-wk", signup, Date.UTC(2026, 6, 6, 10));
    await seedDelivery(orgId, eventId, "forwarded", Date.UTC(2026, 6, 7, 10));
    // Prior-week capture only (no forward) → captured=true, forwarded=false that week.
    const { orgId: bOrg } = await seedOrg(
      "act-wk-b",
      Date.UTC(2026, 5, 29, 9),
      Date.UTC(2026, 5, 30, 10),
    );

    await rollupOrg(orgId);
    await rollupOrg(bOrg);

    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });
    expect(await weeklyOf(bOrg, isoWeek(1))).toEqual({ captured: true, forwarded: false });
    // Cross-org isolation: bOrg has no row in this week.
    expect(await weeklyOf(bOrg, isoWeek(0))).toBeNull();
  });

  it("OR-accumulate is durable: a set forwarded flag survives a re-roll after the forward is PRUNED", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const { orgId, eventId } = await seedOrg("act-accum", signup, Date.UTC(2026, 6, 6, 10));
    await seedDelivery(orgId, eventId, "forwarded", Date.UTC(2026, 6, 6, 12));
    await rollupOrg(orgId);
    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });

    // Retention prunes the forward row (the capture event survives). The re-roll re-detects captured=true
    // but forwarded=false; OR must keep the stored forwarded=true. A plain overwrite would clear it — this
    // is the load-bearing OR-accumulate case.
    await pruneForwards(orgId);
    await rollupOrg(orgId);
    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });
  });
});

describe("activation_weekly_review (SECURITY DEFINER, aggregate-only)", () => {
  it("cohort funnel (signup week) + weekly NSM (activity week), TTFV percentiles, exclusions", async () => {
    // Fresh isolated orgs in a distinct week (two weeks back) so other tests don't perturb the counts. All
    // signed up the same week; the cohort funnel keys on signup week, so signups/reached_*/activation_rate/
    // TTFV all land in this row.
    const wSignup = Date.UTC(2026, 5, 22, 9); // Mon 2026-06-22
    const wk = isoWeek(2); // 2026-06-22
    const HOUR = 3_600_000;

    // Three ACTIVATED orgs with a spread of TTFV latencies (1h, 3h, 9h) so median != p90.
    const a = await seedOrg("rev-a", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(a.orgId, a.eventId, "forwarded", wSignup + 1 * HOUR);
    const b = await seedOrg("rev-b", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(b.orgId, b.eventId, "forwarded", wSignup + 3 * HOUR);
    const g = await seedOrg("rev-g", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(g.orgId, g.eventId, "forwarded", wSignup + 9 * HOUR);
    // Capture-only → reached_capture but NOT reached_forward / activated.
    const c = await seedOrg("rev-c", wSignup, wSignup + 5 * 60_000);
    // Signup-only (no capture) → counts in signups only, so signups != reached_capture.
    const e = await seedOrg("rev-e", wSignup, null);
    // Activated but EXCLUDED (founder/test) → must not count anywhere.
    const d = await seedOrg("rev-excl", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(d.orgId, d.eventId, "forwarded", wSignup + 1 * HOUR);

    for (const o of [a, b, g, c, e, d]) await rollupOrg(o.orgId);
    // Exclude org d via the ops (RLS-bypassing provider) path — exclusions are owner-managed; a tenant
    // never writes them.
    await provider`insert into activation_org_exclusions (org_id, reason) values (${d.orgId}, ${"test"})`;

    // Called through the REAL PRODUCTION ROLE — the same least-privilege webhook_activation_reviewer
    // connection the internal endpoint opens over its Hyperdrive. 0092 revokes EXECUTE from PUBLIC and 0093
    // grants it back to this role alone. NOT `provider`: on the nightly's Neon branch that role holds
    // webhook_owner membership with inherit_option = f AND set_option = f, so it carries none of the owner's
    // rights (`42501`, #717) — a local superuser papers over it. And NOT webhook_app, which must never read
    // cross-org platform aggregates (asserted below).
    const rows = await reviewer<
      {
        iso_week: Date;
        signups: string;
        reached_capture: string;
        reached_forward: string;
        activation_rate: string;
        activated_orgs: string;
        ttfv_median_hours: string;
        ttfv_p90_hours: string;
      }[]
    >`select iso_week, signups, reached_capture, reached_forward, activation_rate, activated_orgs,
             ttfv_median_hours, ttfv_p90_hours
        from activation_weekly_review() where iso_week = ${wk}::date`;

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    // Cohort (signup week wk), excluding d: signups a,b,g,c,e = 5; reached_capture a,b,g,c = 4 (e never
    // captured); reached_forward a,b,g = 3.
    expect(Number(r.signups)).toBe(5);
    expect(Number(r.reached_capture)).toBe(4);
    expect(Number(r.reached_forward)).toBe(3);
    // Cohort conversion, bounded [0,1]: 3 activated / 5 signups.
    expect(Number(r.activation_rate)).toBeCloseTo(0.6, 5);
    // Weekly-recurrence NSM (activity week wk): a,b,g captured+forwarded that week = 3.
    expect(Number(r.activated_orgs)).toBe(3);
    // TTFV over [1h, 3h, 9h]: median = 3, p90 = interpolate(0.9) = 7.8 — and they DIFFER.
    expect(Number(r.ttfv_median_hours)).toBeCloseTo(3, 4);
    expect(Number(r.ttfv_p90_hours)).toBeCloseTo(7.8, 4);
    expect(Number(r.ttfv_median_hours)).not.toBe(Number(r.ttfv_p90_hours));
  });

  it("webhook_app (a tenant) is DENIED — platform aggregates never reach the request-path role", async () => {
    // The review fn is aggregate-only, but even aggregate cross-tenant KPIs are private-by-default; the
    // request-path role holds no execute grant (revoked from PUBLIC), so a tenant cannot enumerate
    // platform signup/activation.
    await expect(app`select * from activation_weekly_review()`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("the reviewer holds EXECUTE and ZERO table privileges — no activation table, no orgs, no events", async () => {
    // Half the safety argument for handing a network-reachable endpoint its own DB role: the SECURITY
    // DEFINER function does the reading, so the reviewer needs no table grants at all. If a future migration
    // hands it `select` on any of these, this fails.
    //
    // Scope, precisely: this pins TABLE privileges only. The other half of the boundary is EXECUTE — USAGE
    // on schema public carries PUBLIC's default EXECUTE on anything that has not revoked it, which is why
    // 0094 revokes it from the identity definers (pinned in rls.test.ts). Neither assertion alone is
    // containment; together they are.
    const [priv] = await provider<
      {
        exec: boolean;
        milestones: boolean;
        weekly: boolean;
        exclusions: boolean;
        orgs: boolean;
        events: boolean;
      }[]
    >`
      select has_function_privilege(${DB_ROLES.activationReviewer}, 'activation_weekly_review()', 'EXECUTE') as exec,
             has_table_privilege(${DB_ROLES.activationReviewer}, 'activation_org_milestones', 'SELECT') as milestones,
             has_table_privilege(${DB_ROLES.activationReviewer}, 'activation_org_weekly', 'SELECT') as weekly,
             has_table_privilege(${DB_ROLES.activationReviewer}, 'activation_org_exclusions', 'SELECT') as exclusions,
             has_table_privilege(${DB_ROLES.activationReviewer}, 'orgs', 'SELECT') as orgs,
             has_table_privilege(${DB_ROLES.activationReviewer}, 'events', 'SELECT') as events`;
    expect(priv).toEqual({
      exec: true,
      milestones: false,
      weekly: false,
      exclusions: false,
      orgs: false,
      events: false,
    });
  });

  it("the reviewer is a LOGIN role that is NON-OWNER, NOSUPERUSER, NOBYPASSRLS", async () => {
    // `login` is load-bearing, not decoration: apps/api connects AS this role over its Hyperdrive, and
    // scripts/dev-db.sh gates `pnpm dev:db` on exactly `rolcanlogin` for every role the wrangler bindings
    // name — which is the check that was failing before 0093 created it (#721). The three negatives are the
    // reason a network-reachable endpoint may hold its own credential at all: it cannot bypass RLS, cannot
    // own anything, and cannot mint roles, so it is confined to the one SECURITY DEFINER function.
    const [role] = await provider<
      { login: boolean; sup: boolean; brls: boolean; createrole: boolean; createdb: boolean }[]
    >`
      select rolcanlogin as login, rolsuper as sup, rolbypassrls as brls, rolcreaterole as createrole,
             rolcreatedb as createdb
        from pg_roles where rolname = ${DB_ROLES.activationReviewer}`;
    expect(role).toEqual({
      login: true,
      sup: false,
      brls: false,
      createrole: false,
      createdb: false,
    });
  });

  it("EXECUTE is pinned to the owner and the reviewer ALONE — PUBLIC revoked, webhook_app denied", async () => {
    // The declarative counterpart to the rejection above, and the invariant #717 turned on: 0092 revokes
    // EXECUTE from PUBLIC and 0093 grants it back to exactly ONE role, so the callers are {owner, reviewer}.
    // Two ways this can silently rot: a future `grant execute … to webhook_app` (every tenant could then
    // enumerate platform-wide signup/activation), or a re-grant to PUBLIC (same, for every role at once).
    // The grantee COUNT is asserted too, so a grant to some third role also fails here rather than sliding
    // in unnoticed. Asserted with has_function_privilege + aclexplode, never information_schema — that view
    // only shows grants visible to the QUERYING role, so on Neon it reports [] and this would false-pass
    // (#413).
    const [acl] = await provider<
      {
        owner_exec: boolean;
        reviewer_exec: boolean;
        app_exec: boolean;
        public_exec: boolean;
        grantees: number;
      }[]
    >`
      select has_function_privilege(${DB_ROLES.owner}, 'activation_weekly_review()', 'EXECUTE') as owner_exec,
             has_function_privilege(${DB_ROLES.activationReviewer}, 'activation_weekly_review()', 'EXECUTE') as reviewer_exec,
             has_function_privilege(${DB_ROLES.app}, 'activation_weekly_review()', 'EXECUTE') as app_exec,
             exists (
               select 1 from pg_proc p, aclexplode(p.proacl) a
                where p.proname = 'activation_weekly_review' and a.grantee = 0
             ) as public_exec,
             (select count(distinct a.grantee)::int
                from pg_proc p, aclexplode(p.proacl) a
               where p.proname = 'activation_weekly_review') as grantees`;
    expect(acl).toEqual({
      owner_exec: true,
      reviewer_exec: true,
      app_exec: false,
      public_exec: false,
      grantees: 2, // webhook_owner + webhook_activation_reviewer, nobody else
    });
  });
});

describe("activation_org_exclusions is ops-only (no tenant access)", () => {
  it("webhook_app holds ZERO table privileges — a tenant can never self-exclude to game the metric", async () => {
    // The exclusions list is secured purely by ownership (no RLS, no grant). Pin that with
    // has_table_privilege (the idiom usage_alerts/billing_* use) so an accidental future GRANT to
    // webhook_app — which would let a tenant remove itself from the founder's activation metric — fails CI.
    const [priv] = await provider<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
      select
        has_table_privilege(${DB_ROLES.app}, 'activation_org_exclusions', 'SELECT') as sel,
        has_table_privilege(${DB_ROLES.app}, 'activation_org_exclusions', 'INSERT') as ins,
        has_table_privilege(${DB_ROLES.app}, 'activation_org_exclusions', 'UPDATE') as upd,
        has_table_privilege(${DB_ROLES.app}, 'activation_org_exclusions', 'DELETE') as del`;
    expect(priv).toEqual({ sel: false, ins: false, upd: false, del: false });

    // Defense in depth: a direct read or write attempt as the tenant role is denied outright.
    await expect(app`select * from activation_org_exclusions`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      app`insert into activation_org_exclusions (org_id, reason) values (${randomUUID()}, ${"x"})`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("runActivationRollup (driver)", () => {
  // Wed 2026-07-08 12:00Z — inside the isoWeek(0) week (Mon 2026-07-06). settleDays:2 → windows Jul 6/7/8,
  // oldest = Jul 6 00:00Z, and the only ISO week the window touches is Mon Jul 6.
  const NOW = Date.UTC(2026, 6, 8, 12);

  it("enumerates active orgs (event OR forward) and rolls up milestones + weekly per org", async () => {
    // FRESH orgs, deliberately NOT pre-rolled — their milestone/weekly rows exist after the run ONLY if the
    // driver enumerated (via webhook_meter) and rolled them up (under webhook_app RLS).
    const cap = Date.UTC(2026, 6, 6, 10);
    const fwd = Date.UTC(2026, 6, 6, 11);
    const a = await seedOrg("drv-a", Date.UTC(2026, 6, 6, 9), cap);
    await seedDelivery(a.orgId, a.eventId, "forwarded", fwd);
    // Capture-only org (no forward) — enumerated via its event, weekly.forwarded stays false.
    const bCap = Date.UTC(2026, 6, 7, 10);
    const b = await seedOrg("drv-b", Date.UTC(2026, 6, 6, 9), bCap);

    const result = await runActivationRollup({ meter, app, now: NOW, settleDays: 2, limit: 1000 });

    // Every enumerated org succeeded (the pass is idempotent over orgs other suites already rolled).
    expect(result.orgsFailed).toBe(0);
    expect(result.capped).toBe(false);
    expect(result.orgsProcessed).toBe(result.orgsSucceeded);
    expect(result.orgsProcessed).toBeGreaterThanOrEqual(2);

    // The driver derived A's set-once milestones + this-week flags.
    const ma = await milestonesOf(a.orgId);
    expect(ma?.first_capture_at?.toISOString()).toBe(new Date(cap).toISOString());
    expect(ma?.first_forward_at?.toISOString()).toBe(new Date(fwd).toISOString());
    expect(await weeklyOf(a.orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });

    // And B's — captured, never forwarded.
    const mb = await milestonesOf(b.orgId);
    expect(mb?.first_capture_at?.toISOString()).toBe(new Date(bCap).toISOString());
    expect(mb?.first_forward_at).toBeNull();
    expect(await weeklyOf(b.orgId, isoWeek(0))).toEqual({ captured: true, forwarded: false });
  });

  it("enumerates an org by a recent forward of an OLDER event (the delivery-arm of the union)", async () => {
    // A developer replays a historical captured event to localhost today: the events row is old (received_at
    // BEFORE the window) but the forward's created_at is INSIDE it. The events-arm of the enumeration would
    // miss this org — only the delivery_attempts-arm catches it — so this proves the union's second arm is
    // load-bearing. (delivery_attempts has a composite FK to events with ON DELETE CASCADE, so a forward can
    // never outlive its event; the realistic "old capture, fresh forward" case keeps the event present.)
    const now = Date.UTC(2026, 6, 15, 12); // Wed 2026-07-15 → settleDays:2 window = Jul 13/14/15, week Jul 13
    const wk = new Date(Date.UTC(2026, 6, 13)).toISOString().slice(0, 10);
    const oldCapture = Date.UTC(2026, 6, 6, 10); // Jul 6 — BEFORE the Jul 13 window
    const replayForward = Date.UTC(2026, 6, 13, 12); // Jul 13 — inside the window
    const { orgId, eventId } = await seedOrg("drv-replay", Date.UTC(2026, 6, 6, 9), oldCapture);
    await seedDelivery(orgId, eventId, "forwarded", replayForward);

    const result = await runActivationRollup({ meter, app, now, settleDays: 2, limit: 1000 });
    expect(result.orgsFailed).toBe(0);

    // Enumerated (via the forward) and rolled up: the replay week shows forwarded, not captured (the capture
    // happened in an earlier week), and the milestone records the replay as this org's first forward.
    expect(await weeklyOf(orgId, wk)).toEqual({ captured: false, forwarded: true });
    expect((await milestonesOf(orgId))?.first_forward_at?.toISOString()).toBe(
      new Date(replayForward).toISOString(),
    );
    // first_capture_at is the absolute MIN — the old event, not the replay.
    expect((await milestonesOf(orgId))?.first_capture_at?.toISOString()).toBe(
      new Date(oldCapture).toISOString(),
    );
  });

  it("re-rolls EVERY ISO week the settle window straddles (a Monday-boundary run)", async () => {
    // Run at 00:30 UTC on Monday 2026-07-13: settleDays:2 → windows Jul 11(Sat)/12(Sun)/13(Mon), which
    // straddle TWO ISO weeks (Mon Jul 6 and Mon Jul 13). The driver must re-roll BOTH weeks, so an org
    // active in the closing week AND an org active early on the new Monday each land in their own week. This
    // is what makes `[...new Set(windows.map(isoWeekMonday))]` load-bearing — dropping the older week would
    // silently delay the prior week's captured/forwarded flag for orgs that were active late in it.
    const now = Date.UTC(2026, 6, 13, 0, 30);
    const weekOld = "2026-07-06"; // Mon of the closing week
    const weekNew = "2026-07-13"; // Mon of the new week (== now's week)

    // Active late in the OLD week (Sat Jul 11).
    const old = await seedOrg("drv-strad-old", Date.UTC(2026, 6, 6, 9), Date.UTC(2026, 6, 11, 10));
    await seedDelivery(old.orgId, old.eventId, "forwarded", Date.UTC(2026, 6, 11, 11));
    // Active early on the NEW Monday (Jul 13 00:05, before `now`).
    const fresh = await seedOrg(
      "drv-strad-new",
      Date.UTC(2026, 6, 6, 9),
      Date.UTC(2026, 6, 13, 0, 5),
    );
    await seedDelivery(fresh.orgId, fresh.eventId, "forwarded", Date.UTC(2026, 6, 13, 0, 10));

    const result = await runActivationRollup({ meter, app, now, settleDays: 2, limit: 1000 });
    expect(result.orgsFailed).toBe(0);

    // The OLD-week org's flags land in the OLD week (the discriminating assertion — a dropped older week
    // would leave this null), and it has no row in the new week.
    expect(await weeklyOf(old.orgId, weekOld)).toEqual({ captured: true, forwarded: true });
    expect(await weeklyOf(old.orgId, weekNew)).toBeNull();
    // The NEW-week org's flags land in the new week, and it has no row in the old week.
    expect(await weeklyOf(fresh.orgId, weekNew)).toEqual({ captured: true, forwarded: true });
    expect(await weeklyOf(fresh.orgId, weekOld)).toBeNull();
  });
});

describe("runActivationRollup per-org isolation (unit, fakes)", () => {
  // One org's failure must not skip the rest of the pass. Deterministic fakes so the try/catch control flow
  // is actually exercised (a real mid-rollup DB error is hard to force). Mirrors delivery-stats-rollup's
  // isolation test: withTenant(app, orgId, cb) → app.begin(cb') where cb' runs `tx`select set_config(...)``
  // first, so rejecting THAT call for one org fails exactly that org.
  const NOW = Date.UTC(2026, 6, 8, 12);

  function fakeApp(failOrg: string | null): Sql {
    return {
      begin: async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("?");
          if (failOrg && text.includes("set_config") && values.includes(failOrg)) {
            return Promise.reject(new Error("boom"));
          }
          return Promise.resolve([]);
        };
        return cb(tx);
      },
    } as unknown as Sql;
  }

  it("isolates a failing org: logs it, counts it, and still processes the rest", async () => {
    const enumerated = [{ org_id: "ok-1" }, { org_id: "fail-1" }, { org_id: "ok-2" }];
    const fakeMeter = (() => Promise.resolve(enumerated)) as unknown as Sql;

    const failedOrgs: string[] = [];
    const result = await runActivationRollup({
      meter: fakeMeter,
      app: fakeApp("fail-1"),
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

  it("flags + logs capped when the enumeration fills the limit", async () => {
    const enumerated = [{ org_id: "c-1" }, { org_id: "c-2" }];
    const fakeMeter = (() => Promise.resolve(enumerated)) as unknown as Sql;

    const capped: string[] = [];
    const result = await runActivationRollup({
      meter: fakeMeter,
      app: fakeApp(null),
      now: NOW,
      settleDays: 1,
      limit: 2, // exactly the enumerated count → capped
      log: (message) => {
        if (message === "activation.rollup.capped") capped.push(message);
      },
    });

    expect(result.capped).toBe(true);
    expect(capped).toHaveLength(1);
  });
});

describe("readActivationWeeklyReview (typed reader)", () => {
  it("maps activation_weekly_review() rows to a typed, camel-cased shape (numbers, ISO week)", async () => {
    // Fresh cohort in an ISO week no other test touches (Mon 2026-06-15 = isoWeek(3), which the shared
    // rollupOrg helper re-rolls). Every one of the six count/derived fields is given a DISTINCT value so the
    // mapping test can catch any column swap (a passthrough reader's whole job is the column→field mapping):
    //   signups 5 ≠ reachedCapture 4 ≠ reachedForward 3 ≠ activatedOrgs 2 ≠ activationRate 0.6 ≠ ttfv.
    const wSignup = Date.UTC(2026, 5, 15, 9); // Mon 2026-06-15
    const wk = "2026-06-15";
    const HOUR = 3_600_000;
    // a, b: signup + capture + forward all in-week → both cohort-forwarders AND activated-in-week.
    const a = await seedOrg("rd-a", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(a.orgId, a.eventId, "forwarded", wSignup + 1 * HOUR);
    const b = await seedOrg("rd-b", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(b.orgId, b.eventId, "forwarded", wSignup + 1.5 * HOUR);
    // c: signup + capture, NO forward → in reachedCapture, not reachedForward/activated.
    const c = await seedOrg("rd-c", wSignup, wSignup + 5 * 60_000);
    // e: signup only, NO capture → in signups, not reachedCapture. (signups 5 ≠ reachedCapture 4)
    const e = await seedOrg("rd-e", wSignup, null);
    // f: signup + capture in-week, but FORWARDS a week later (Mon 2026-06-22). So f is an ever-forwarder in
    // the Jun-15 signup cohort (reachedForward counts it) but is NOT activated in the Jun-15 activity week
    // (its forward lands in Jun-22). This is what makes reachedForward 3 ≠ activatedOrgs 2.
    const f = await seedOrg("rd-f", wSignup, wSignup + 5 * 60_000);
    await seedDelivery(f.orgId, f.eventId, "forwarded", wSignup + 168 * HOUR); // +7 days → Jun-22 week
    for (const o of [a, b, c, e, f]) await rollupOrg(o.orgId);

    // Read through the reviewer role — the exact handle apps/api hands this same function in production, so
    // this covers the wrapper AND its caller's grant in one go. webhook_app is denied EXECUTE by design; so
    // is the Neon provider role (#717).
    const rows = await readActivationWeeklyReview(reviewer);
    const row = rows.find((r) => r.isoWeek === wk);

    expect(row).toBeDefined();
    // Typed + camel-cased, with SQL bigints/numerics coerced to JS numbers (not strings). All-distinct values
    // mean any swapped column assignment in the reader flips at least one field here.
    expect(row).toEqual({
      isoWeek: wk,
      signups: 5,
      reachedCapture: 4,
      reachedForward: 3,
      activatedOrgs: 2,
      activationRate: expect.closeTo(0.6, 4), // reached_forward 3 / signups 5
      ttfvMedianHours: expect.closeTo(1.5, 4), // median of [1h, 1.5h, 168h]
      ttfvP90Hours: expect.closeTo(134.7, 2), // p90 of [1h, 1.5h, 168h]
    });
    // Guard the string→number coercion explicitly (a raw postgres.js row returns bigints as strings).
    expect(typeof row!.signups).toBe("number");
    expect(typeof row!.activationRate).toBe("number");
    // Rows are ordered oldest→newest.
    const weeks = rows.map((r) => r.isoWeek);
    expect(weeks).toEqual([...weeks].sort());
  });
});
