import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { runUsageRollup } from "../src/usage-rollup";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The rollup ORCHESTRATION (S4.1): a cron enumerates orgs with recent activity (as the
// least-privilege cross-org webhook_meter role), then per-org, under webhook_app RLS,
// re-rolls the settle-window days (yesterday+today) and FREEZES aged days. Money-correct:
//   - re-rolls the just-closed day so the pre-midnight tail is never lost (F2);
//   - a finalized day's count is immutable — never recounted, so a later events prune
//     can't make a billed number silently decrease (F1);
//   - UTC-day-aligned windows so the bucket can't drift with server TZ (F4);
//   - the meter role reads only (org_id, received_at) — never any payload.

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0); // 2026-07-07T12:00Z — fixed for deterministic windows
const SETTLE_DAYS = 2;

// UTC-midnight ISO of the day `d` days before NOW.
function dayIso(daysAgo: number): string {
  const today = Date.UTC(2026, 6, 7); // start of NOW's UTC day
  return new Date(today - daysAgo * DAY_MS).toISOString();
}

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;

async function seedOrg(slug: string): Promise<{ orgId: string; endpointId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
  });
  return { orgId, endpointId };
}

// Insert `n` events and place them on the UTC day `daysAgo` before NOW. received_at is
// trigger-stamped to now() on INSERT (H5), so we UPDATE it to the target instant after.
async function seedEvents(
  orgId: string,
  endpointId: string,
  n: number,
  daysAgo: number,
  keyPrefix: string,
): Promise<void> {
  const at = new Date(Date.UTC(2026, 6, 7) - daysAgo * DAY_MS + 3_600_000).toISOString();
  await withTenant(app, orgId, async (tx) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${id}, ${orgId}, ${endpointId}, ${keyPrefix + i}, ${10}, ${keyPrefix + i}, ${"content_hash"})`;
      await tx`update events set received_at = ${at} where id = ${id}`;
    }
  });
}

/** Seed `n` outbound delivery DISPATCHES on the UTC day `daysAgo`. One `delivery_attempts` row = one
 *  dispatch; `attempt` is the retry counter that later UPDATEs bump in place, never a new row. */
async function seedDispatches(
  orgId: string,
  eventId: string,
  n: number,
  daysAgo: number,
  attempt = 1,
): Promise<string[]> {
  const at = new Date(Date.UTC(2026, 6, 7) - daysAgo * DAY_MS + 3_600_000).toISOString();
  const ids: string[] = [];
  await withTenant(app, orgId, async (tx) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await tx`insert into delivery_attempts (id, org_id, event_id, target, status, attempt, created_at)
               values (${id}, ${orgId}, ${eventId}, ${"https://x.test/" + i}, ${"queued"}, ${attempt}, ${at})`;
      ids.push(id);
    }
  });
  return ids;
}

/** One event to hang deliveries off (delivery_attempts FKs (event_id, org_id)). */
async function seedOneEvent(
  orgId: string,
  endpointId: string,
  daysAgo: number,
  key: string,
): Promise<string> {
  const at = new Date(Date.UTC(2026, 6, 7) - daysAgo * DAY_MS + 3_600_000).toISOString();
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${id}, ${orgId}, ${endpointId}, ${key}, ${10}, ${key}, ${"content_hash"})`;
    await tx`update events set received_at = ${at} where id = ${id}`;
  });
  return id;
}

async function usageAt(
  orgId: string,
  windowIso: string,
): Promise<{ count: number; finalized: boolean } | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ event_count: number; finalized_at: string | null }[]>`
      select event_count, finalized_at from usage
      where org_id = ${orgId} and window_start = ${windowIso}`;
    return row ? { count: Number(row.event_count), finalized: row.finalized_at !== null } : null;
  });
}

async function run(): Promise<void> {
  await runUsageRollup({ meter, app, now: NOW, settleDays: SETTLE_DAYS, limit: 1000 });
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

describe("runUsageRollup", () => {
  it("rolls up the settle-window days for each enumerated org (RLS-isolated)", async () => {
    const a = await seedOrg("roll-a");
    const b = await seedOrg("roll-b");
    await seedEvents(a.orgId, a.endpointId, 3, 0, "a-today"); // today
    await seedEvents(a.orgId, a.endpointId, 2, 1, "a-yest"); // yesterday
    await seedEvents(b.orgId, b.endpointId, 5, 0, "b-today"); // today

    await run();

    expect(await usageAt(a.orgId, dayIso(0))).toEqual({ count: 3, finalized: false });
    expect(await usageAt(a.orgId, dayIso(1))).toEqual({ count: 2, finalized: false });
    expect(await usageAt(b.orgId, dayIso(0))).toEqual({ count: 5, finalized: false });
    // A never sees B's events (no leak): B has no row for A's org and counts are exact.
    expect(await usageAt(b.orgId, dayIso(1))).toBeNull();
  });

  it("re-rolls the just-closed day so a late pre-midnight event is not lost (F2)", async () => {
    const { orgId, endpointId } = await seedOrg("roll-tail");
    await seedEvents(orgId, endpointId, 4, 1, "tail-a"); // yesterday
    await run();
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 4, finalized: false });

    // A late event for yesterday commits after the first run; the next run re-rolls it.
    await seedEvents(orgId, endpointId, 1, 1, "tail-late");
    await run();
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 5, finalized: false });
  });

  it("finalizes days older than the settle window and never recounts them (F1)", async () => {
    const { orgId, endpointId } = await seedOrg("roll-freeze");
    // Pre-existing OPEN usage row for an aged day (5 days ago, well past the cutoff),
    // as a prior run would have left it. finalized_at is null.
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${dayIso(5)}, ${100})`;
    });

    await run();

    const frozen = await usageAt(orgId, dayIso(5));
    expect(frozen).toEqual({ count: 100, finalized: true });

    // Now inject events into that already-finalized day and re-run: the count must NOT move.
    await seedEvents(orgId, endpointId, 7, 5, "freeze-late");
    await run();
    expect(await usageAt(orgId, dayIso(5))).toEqual({ count: 100, finalized: true });
  });

  it("finalizes an idle org's aged open day even with no recent events", async () => {
    // An org that stopped sending must still get its last open day frozen (else it never
    // reports to Stripe). Enumeration must include stale-open usage, not only recent events.
    const { orgId } = await seedOrg("roll-idle");
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${dayIso(4)}, ${42})`;
    });
    await run();
    expect(await usageAt(orgId, dayIso(4))).toEqual({ count: 42, finalized: true });
  });

  it("a non-positive settleDays is a safe no-op (no windows → nothing enumerated)", async () => {
    const result = await runUsageRollup({ meter, app, now: NOW, settleDays: -1, limit: 1000 });
    expect(result).toEqual({
      orgsProcessed: 0,
      orgsSucceeded: 0,
      orgsFailed: 0,
      daysFinalized: 0,
      capped: false,
    });
  });

  it("the webhook_meter role can enumerate (org_id, received_at) but never a payload column", async () => {
    const can = async (col: string): Promise<boolean> => {
      const [{ ok }] = await meter<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meter}, 'events', ${col}, 'SELECT') as ok`;
      return ok;
    };
    expect(await can("org_id")).toBe(true);
    expect(await can("received_at")).toBe(true);
    expect(await can("payload_r2_key")).toBe(false);
    expect(await can("headers")).toBe(false);
    expect(await can("dedup_key")).toBe(false);
  });
});

describe("usage finalized-immutable trigger", () => {
  // DB-enforced money-integrity: once a day is frozen, its billing snapshot cannot change,
  // regardless of writer (webhook_app holds table UPDATE on usage, so the rollup's on-conflict
  // guard alone isn't sufficient — the trigger is the writer-agnostic backstop).
  async function seedFinalized(slug: string): Promise<string> {
    const orgId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
      await tx`insert into usage (org_id, window_start, event_count, finalized_at)
               values (${orgId}, ${dayIso(6)}, ${50}, now())`;
    });
    return orgId;
  }

  it("rejects changing a finalized row's event_count", async () => {
    const orgId = await seedFinalized("immut-count");
    await expect(
      withTenant(app, orgId, async (tx) => {
        await tx`update usage set event_count = ${999} where org_id = ${orgId} and window_start = ${dayIso(6)}`;
      }),
    ).rejects.toThrow(/finalized and immutable/);
    expect(await usageAt(orgId, dayIso(6))).toEqual({ count: 50, finalized: true });
  });

  it("rejects clearing a finalized row's finalized_at (no un-freezing)", async () => {
    const orgId = await seedFinalized("immut-clear");
    await expect(
      withTenant(app, orgId, async (tx) => {
        await tx`update usage set finalized_at = null where org_id = ${orgId} and window_start = ${dayIso(6)}`;
      }),
    ).rejects.toThrow(/finalized and immutable/);
    expect(await usageAt(orgId, dayIso(6))).toEqual({ count: 50, finalized: true });
  });

  it("allows updating an OPEN (not-yet-finalized) row's count", async () => {
    const orgId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"immut-open"}, ${"immut-open"})`;
      await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${dayIso(6)}, ${5})`;
      await tx`update usage set event_count = ${7} where org_id = ${orgId} and window_start = ${dayIso(6)}`;
    });
    expect(await usageAt(orgId, dayIso(6))).toEqual({ count: 7, finalized: false });
  });
});

describe("runUsageRollup per-org isolation (unit, fakes)", () => {
  // One org's failure must not skip the rest of the pass, and a persistently-failing org must
  // not block the downstream subset every pass. Deterministic fakes so the control flow is
  // exercised without depending on a hard-to-force real DB error.
  it("isolates a failing org: logs it, counts it, and still processes the rest", async () => {
    const enumerated = [{ org_id: "ok-1" }, { org_id: "fail-1" }, { org_id: "ok-2" }];
    const fakeMeter = (() => Promise.resolve(enumerated)) as unknown as Sql;
    const fakeApp = {
      begin: async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("?");
          if (text.includes("set_config") && values.includes("fail-1")) {
            return Promise.reject(new Error("boom"));
          }
          if (text.includes("update usage")) {
            const rows: unknown[] & { count?: number } = [];
            rows.count = 0;
            return Promise.resolve(rows);
          }
          return Promise.resolve([]);
        };
        return cb(tx);
      },
    } as unknown as Sql;

    const failedOrgs: string[] = [];
    const result = await runUsageRollup({
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

describe("Definition B — a billed event is one CAPTURE or one DELIVERY DISPATCH", () => {
  it("counts captures AND dispatches into the same usage window", async () => {
    const { orgId, endpointId } = await seedOrg("defb-both");
    await seedEvents(orgId, endpointId, 3, 1, "c");
    const eventId = await seedOneEvent(orgId, endpointId, 1, "anchor");
    await seedDispatches(orgId, eventId, 4, 1);
    await run();
    // 3 captures + 1 anchor capture + 4 dispatches = 8 billed events.
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 8, finalized: false });
  });

  it("NEVER bills a retry — a retry updates its row in place, it does not insert a new one", async () => {
    // The load-bearing guarantee. Our retry schedule is our cost; a receiver's downtime is not the
    // customer's fault. `count(*)` over delivery_attempts must be immune to the `attempt` counter.
    const { orgId, endpointId } = await seedOrg("defb-retry");
    const eventId = await seedOneEvent(orgId, endpointId, 1, "retry-anchor");
    const [dispatchId] = await seedDispatches(orgId, eventId, 1, 1);
    await run();
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 2, finalized: false }); // 1 capture + 1 dispatch

    // Simulate the DeliveryDO exhausting its retry schedule on that same dispatch.
    await withTenant(app, orgId, async (tx) => {
      for (const attempt of [2, 3, 4, 5, 6, 7, 8]) {
        await tx`update delivery_attempts set attempt = ${attempt}, status = 'pending' where id = ${dispatchId}`;
      }
    });
    await run();
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 2, finalized: false }); // still 2, not 9
  });

  it("bills an org that ONLY delivered (a replay of an older event) — no capture that day", async () => {
    const { orgId, endpointId } = await seedOrg("defb-replay-only");
    const eventId = await seedOneEvent(orgId, endpointId, 3, "old"); // captured 3 days ago
    await seedDispatches(orgId, eventId, 5, 1); // replayed yesterday
    await run();
    // The union's outer group-by must still produce a row for a day with zero captures.
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 5, finalized: false });
  });

  it("is idempotent — re-rolling recomputes the identical count", async () => {
    const { orgId, endpointId } = await seedOrg("defb-idem");
    const eventId = await seedOneEvent(orgId, endpointId, 1, "idem");
    await seedDispatches(orgId, eventId, 6, 1);
    await run();
    await run();
    await run();
    expect(await usageAt(orgId, dayIso(1))).toEqual({ count: 7, finalized: false });
  });

  it("marks rows it writes as counts_deliveries — the basis that produced them", async () => {
    // The F6 oracle recounts each day under its own basis. A row written pre-Definition-B is
    // capture-only and immutable; a row written now includes dispatches.
    const { orgId, endpointId } = await seedOrg("defb-basis");
    await seedEvents(orgId, endpointId, 2, 1, "basis");
    await run();
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ counts_deliveries: boolean }[]>`
      select counts_deliveries from usage where org_id = ${orgId} and window_start = ${dayIso(1)}`,
    );
    expect(row.counts_deliveries).toBe(true);
  });

  it("does NOT retro-count deliveries into an already-FINALIZED day (no retro-billing)", async () => {
    // Models a row written BEFORE Definition B: capture-only, and frozen (money-guard F1). Deliveries we
    // previously gave away must never be back-billed onto it. The explicit insert leaves counts_deliveries
    // at its pre-migration value (false), exactly like a real historical row.
    const { orgId, endpointId } = await seedOrg("defb-finalized");
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into usage (org_id, window_start, event_count, counts_deliveries)
               values (${orgId}, ${dayIso(4)}, ${2}, ${false})`;
    });
    await run(); // ages past the settle window -> frozen
    expect(await usageAt(orgId, dayIso(4))).toEqual({ count: 2, finalized: true });

    const eventId = await seedOneEvent(orgId, endpointId, 4, "late");
    await seedDispatches(orgId, eventId, 9, 4); // 9 dispatches now sit inside that frozen window
    await run();
    // Frozen: the billed number must not move, and must not silently increase.
    expect(await usageAt(orgId, dayIso(4))).toEqual({ count: 2, finalized: true });

    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ counts_deliveries: boolean }[]>`
      select counts_deliveries from usage where org_id = ${orgId} and window_start = ${dayIso(4)}`,
    );
    expect(row.counts_deliveries).toBe(false); // still recounted capture-only by the F6 oracle
  });
});
