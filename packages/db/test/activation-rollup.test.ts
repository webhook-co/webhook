import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
// not bypassing RLS — and returns AGGREGATES ONLY (no org_id, no PII). This suite asserts real rows.

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
let meter: Sql;
// The provider (RLS-bypassing) connection — the harness handle for ops writes like seeding the
// metric-exclusions list (owner-managed in prod; a tenant never touches it).
let provider: Sql;

/** Seed an org (with an explicit created_at = signup time) + one endpoint + one event at `eventAtMs`. */
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
      // received_at is trigger-stamped to now() on INSERT (events_received_at_biu), so set the fixture
      // instant with a follow-up UPDATE — the pattern the metering/usage tests use.
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

/** Run both rollup functions for one org. Milestones scan all retained rows (set-once, backfill-safe);
 *  weekly is re-rolled across a settle window (here weeks 0..3 back, covering every fixture's activity). */
async function rollupOrg(orgId: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`set local time zone 'UTC'`;
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
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await provider?.end();
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

  it("is set-once/monotonic: a later re-roll never moves a milestone later", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const firstCap = Date.UTC(2026, 6, 6, 12);
    const { orgId, endpointId } = await seedOrg("act-mono", signup, firstCap);
    await rollupOrg(orgId);
    expect((await milestonesOf(orgId))?.first_capture_at?.toISOString()).toBe(
      new Date(firstCap).toISOString(),
    );

    // A LATER event arrives; re-roll. first_capture_at must stay at the earliest (LEAST).
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
    const { orgId: bOrg, endpointId: bEp } = await seedOrg(
      "act-wk-b",
      Date.UTC(2026, 5, 29, 9),
      Date.UTC(2026, 5, 30, 10),
    );
    void bEp;

    await rollupOrg(orgId);
    await rollupOrg(bOrg);

    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });
    expect(await weeklyOf(bOrg, isoWeek(1))).toEqual({ captured: true, forwarded: false });
    // Cross-org isolation: bOrg has no row in this week.
    expect(await weeklyOf(bOrg, isoWeek(0))).toBeNull();
  });

  it("OR-accumulates: a later forward in the same week flips forwarded without unflipping captured", async () => {
    const signup = Date.UTC(2026, 6, 6, 9);
    const { orgId, eventId } = await seedOrg("act-accum", signup, Date.UTC(2026, 6, 6, 10));
    await rollupOrg(orgId);
    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: false });

    await seedDelivery(orgId, eventId, "forwarded", Date.UTC(2026, 6, 8, 10));
    await rollupOrg(orgId);
    expect(await weeklyOf(orgId, isoWeek(0))).toEqual({ captured: true, forwarded: true });
  });
});

describe("activation_weekly_review (SECURITY DEFINER, aggregate-only)", () => {
  it("counts distinct activated orgs per week, computes TTFV, and honors exclusions", async () => {
    // Fresh isolated orgs in a distinct week (two weeks back) so other tests don't perturb the counts.
    const wSignup = Date.UTC(2026, 5, 22, 9); // Mon 2026-06-22
    const wk = isoWeek(2); // 2026-06-22
    const capAt = Date.UTC(2026, 5, 22, 10);
    const fwdAt = Date.UTC(2026, 5, 22, 12); // TTFV = 3h from signup

    // Org 1: captured + forwarded → activated.
    const a = await seedOrg("rev-a", wSignup, capAt);
    await seedDelivery(a.orgId, a.eventId, "forwarded", fwdAt);
    // Org 2: captured + forwarded → activated (same week).
    const b = await seedOrg("rev-b", wSignup, capAt);
    await seedDelivery(b.orgId, b.eventId, "forwarded", fwdAt);
    // Org 3: captured only → NOT activated (counts as a first-capture, not the NSM).
    const c = await seedOrg("rev-c", wSignup, capAt);
    // Org 4: activated but EXCLUDED (founder/test) → must not count anywhere.
    const d = await seedOrg("rev-excl", wSignup, capAt);
    await seedDelivery(d.orgId, d.eventId, "forwarded", fwdAt);

    for (const o of [a, b, c, d]) await rollupOrg(o.orgId);
    // Exclude org d via the ops (RLS-bypassing provider) path — exclusions are owner-managed; a tenant
    // never writes them.
    await provider`insert into activation_org_exclusions (org_id, reason) values (${d.orgId}, ${"test"})`;

    const rows = await app<
      {
        iso_week: Date;
        signups: string;
        first_captures: string;
        first_forwards: string;
        activated_orgs: string;
        ttfv_median_hours: string | null;
      }[]
    >`select iso_week, signups, first_captures, first_forwards, activated_orgs, ttfv_median_hours
      from activation_weekly_review() where iso_week = ${wk}::date`;

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    // a + b activated (c capture-only, d excluded). signups counts a,b,c (d excluded).
    expect(Number(r.activated_orgs)).toBe(2);
    expect(Number(r.first_captures)).toBe(3);
    expect(Number(r.first_forwards)).toBe(2);
    expect(Number(r.signups)).toBe(3);
    expect(Number(r.ttfv_median_hours)).toBeCloseTo(3, 5);
  });
});
