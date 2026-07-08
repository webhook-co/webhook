import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { reconcileMeteringUsage } from "../src/meter-reconcile";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// S4.4d reconciliation oracle (F6): recount raw `events` per finalized day from scratch (via the
// independent webhook_meter_audit role) and compare to the frozen `usage.event_count`. A drift means a
// rollup bug froze a wrong billable count — alarm on it. Only FINALIZED days are checked; the recount is
// strictly per-org (one org's events never inflate another's); days outside the lookback aren't scanned.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z

let pg: EphemeralPostgres;
let app: Sql; // seeds usage + events under RLS
let audit: Sql; // the reconciliation role — cross-org, read-only
let admin: Sql; // superuser cleanup

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

/** Insert `n` events for `org` on the UTC day `dayIso` (received_at is trigger-stamped, then set). */
async function seedEvents(org: string, dayIso: string, n: number): Promise<void> {
  const endpointId = randomUUID();
  const at = dayIso.replace("T00:00:00.000Z", "T06:00:00.000Z");
  await withTenant(app, org, async (tx) => {
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${org}, ${randomBytes(32)}, ${"ep"})`;
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${id}, ${org}, ${endpointId}, ${"k" + id}, ${10}, ${dayIso + "-" + i}, ${"content_hash"})`;
      await tx`update events set received_at = ${at} where id = ${id}`;
    }
  });
}

/** Freeze a `usage` day at `frozenCount` (finalized_at set). */
async function seedFrozenUsage(org: string, dayIso: string, frozenCount: number): Promise<void> {
  await withTenant(app, org, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count, finalized_at)
             values (${org}, ${dayIso}, ${frozenCount}, ${"2026-07-15T00:00:00Z"})`;
  });
}

/** An OPEN (unfinalized) usage day at `count`. */
async function seedOpenUsage(org: string, dayIso: string, count: number): Promise<void> {
  await withTenant(app, org, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${org}, ${dayIso}, ${count})`;
  });
}

function run(limit = 1000, lookbackDays = 40) {
  return reconcileMeteringUsage({ audit, now: NOW, lookbackDays, limit });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  audit = createClient(pg.urlFor({ role: DB_ROLES.meterAudit }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from events`;
  await admin`delete from usage`;
  await admin`delete from endpoints`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await audit?.end();
  await admin?.end();
  await pg?.stop();
});

describe("reconcileMeteringUsage", () => {
  it("reports NO drift when the frozen count equals a fresh recount", async () => {
    const org = await seedOrg();
    await seedEvents(org, "2026-07-10T00:00:00.000Z", 5);
    await seedFrozenUsage(org, "2026-07-10T00:00:00.000Z", 5);

    const res = await run();
    expect(res.daysChecked).toBe(1);
    expect(res.mismatches).toEqual([]);
  });

  it("flags an UNDER-count (frozen < actual events) — the org was billed too little", async () => {
    const org = await seedOrg();
    await seedEvents(org, "2026-07-10T00:00:00.000Z", 8);
    await seedFrozenUsage(org, "2026-07-10T00:00:00.000Z", 5); // rollup froze 5, but 8 events exist

    const res = await run();
    expect(res.mismatches).toEqual([{ orgId: org, day: "2026-07-10", rollup: 5, recount: 8 }]);
  });

  it("flags an OVER-count (frozen > actual events) — the org would be billed too much", async () => {
    const org = await seedOrg();
    await seedEvents(org, "2026-07-10T00:00:00.000Z", 3);
    await seedFrozenUsage(org, "2026-07-10T00:00:00.000Z", 9);

    const res = await run();
    expect(res.mismatches).toEqual([{ orgId: org, day: "2026-07-10", rollup: 9, recount: 3 }]);
  });

  it("does NOT check an OPEN (unfinalized) day — only frozen days are billable + immutable", async () => {
    const org = await seedOrg();
    await seedEvents(org, "2026-07-14T00:00:00.000Z", 4);
    await seedOpenUsage(org, "2026-07-14T00:00:00.000Z", 999); // wildly wrong, but not finalized
    const res = await run();
    expect(res.daysChecked).toBe(0);
    expect(res.mismatches).toEqual([]);
  });

  it("recounts strictly per-org — one org's events never inflate another's day", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    // Same day for both. A has 4 events + a correct frozen 4; B has 2 events but a wrong frozen 6.
    await seedEvents(a, "2026-07-10T00:00:00.000Z", 4);
    await seedFrozenUsage(a, "2026-07-10T00:00:00.000Z", 4);
    await seedEvents(b, "2026-07-10T00:00:00.000Z", 2);
    await seedFrozenUsage(b, "2026-07-10T00:00:00.000Z", 6);

    const res = await run();
    expect(res.daysChecked).toBe(2);
    // Only B drifts; A's recount is its own 4 (not 4+2), so A is clean.
    expect(res.mismatches).toEqual([{ orgId: b, day: "2026-07-10", rollup: 6, recount: 2 }]);
  });

  it("does not scan a finalized day OUTSIDE the lookback window", async () => {
    const org = await seedOrg();
    // A drifted day 50 days before NOW, with a 40-day lookback → out of range, not scanned.
    await seedEvents(org, "2026-05-26T00:00:00.000Z", 1);
    await seedFrozenUsage(org, "2026-05-26T00:00:00.000Z", 99);
    const res = await run(1000, 40);
    expect(res.daysChecked).toBe(0);
    expect(res.mismatches).toEqual([]);
  });

  it("caps the mismatch list at `limit` and flags `capped` for the alarm operator", async () => {
    const org = await seedOrg();
    await seedEvents(org, "2026-07-08T00:00:00.000Z", 1);
    await seedFrozenUsage(org, "2026-07-08T00:00:00.000Z", 2);
    await seedEvents(org, "2026-07-09T00:00:00.000Z", 1);
    await seedFrozenUsage(org, "2026-07-09T00:00:00.000Z", 2);
    const res = await run(1); // only surface one mismatch this pass
    expect(res.mismatches.length).toBe(1);
    expect(res.capped).toBe(true);
  });
});
