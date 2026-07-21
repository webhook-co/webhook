import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { markDeliveryTerminalFailure } from "../src/delivery";
import { reconcileMeteringUsage } from "../src/meter-reconcile";
import { sumPeriodEventUsage } from "../src/period-usage";
import {
  claimDeliveryAttempt,
  finalizeDeliveryAttempt,
  recordDeliveryAttempt,
  serializeTarget,
} from "../src/replay";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// S1 "metering truth" — `delivery_attempts.billable`, the one discriminator every metering leg reads.
//
// Definition B bills one inbound CAPTURE or one outbound delivery DISPATCH. Two kinds of row were being
// counted as a dispatch that are not one:
//
//   1. A LOCALHOST TUNNEL FORWARD (`wbhk listen --forward` / `wbhk replay`). The CLI POSTs from the user's
//      own machine and calls events.replay only to RECORD it; our Worker makes no outbound request at all.
//      It is not "a delivery to a destination" — `destination_id` is null — and the pricing page already
//      gives away the two calls it does cost us (events.get + events.getPayload). It was billing the wedge
//      command's every webhook TWICE.
//   2. A delivery the SSRF guard REFUSED to send (`blocked`). The bytes never left our network. Billing it
//      is unbounded bill-shock for a misconfigured destination URL — the exact surprise this product exists
//      to prevent — and `blocked` deliberately does not trip auto-disable, so nothing bounds it.
//
// The discriminator is an EXPLICIT column, never inferred from `destination_id is null`: nothing enforces
// that invariant, so a future writer that forgot it would become silent unbilled revenue. `default true`
// means a forgetful writer fails toward billing real work, not away from it.
//
// The column is IMMUTABLE-IN-PRACTICE, enforced by a DB trigger, and that is load-bearing for the F6
// reconciliation oracle: F6 recounts `delivery_attempts` from scratch and compares to the FROZEN
// `usage.event_count`. A recount is only sound if it is a pure function of state that cannot change after
// the day was frozen. So the trigger enforces (a) billable never rises back to true, and (b) it can never
// fall to false once the row's own UTC day has been finalized in `usage` — that day was already billed, and
// `usage` is immutable (money-guard F1). Without (b), a delivery still `queued` when its day froze and only
// blocked afterwards would make the recount undershoot a correct frozen count forever: an unfixable drift
// alarm on the one signal guarding live money.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z
const DAY_MS = 86_400_000;

let pg: EphemeralPostgres;
let app: Sql;
let audit: Sql;
let provider: Sql; // BYPASSRLS — cross-org reads that must see a row no tenant GUC is set for
let owner: Sql; // the schema owner — the only role that may TRUNCATE (see below)

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  audit = createClient(pg.urlFor({ role: DB_ROLES.meterAudit }));
  provider = createClient(pg.providerUrl);
  // Cleanup TRUNCATEs, so it runs as the SCHEMA OWNER — not as `provider`. TRUNCATE requires
  // ownership, and on the nightly's Neon branch the provider role owns nothing (it holds
  // webhook_owner membership with inherit_option = f) → 42501 permission denied. RLS never filters
  // TRUNCATE, so the owner's FORCE RLS is not in the way. The provider USED to be the postgres
  // superuser locally, which bypasses the ACL check — which is exactly why truncating on it passed
  // every local run and only broke on the nightly, against Neon (issue #383). Since #728 it is a
  // non-superuser in BOTH lanes, so that mistake now fails locally too (provider-fidelity.test.ts).
  owner = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await Promise.all([app?.end(), audit?.end(), provider?.end(), owner?.end()]);
  await pg?.stop();
});

afterEach(async () => {
  await owner`truncate delivery_attempts, events, endpoints, usage, orgs cascade`;
});

/** UTC-midnight ISO of the day `daysAgo` before NOW. */
function dayIso(daysAgo: number): string {
  return new Date(Date.UTC(2026, 6, 15) - daysAgo * DAY_MS).toISOString();
}

/** An org + one endpoint + one event on `daysAgo` — the anchor delivery_attempts FKs to. */
async function seedOrgWithEvent(daysAgo = 0): Promise<{ orgId: string; eventId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  const eventId = randomUUID();
  const at = new Date(Date.UTC(2026, 6, 15) - daysAgo * DAY_MS + 6 * 3_600_000).toISOString();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at)
             values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"}, ${"2026-01-01T00:00:00Z"})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${eventId}, ${orgId}, ${endpointId}, ${"k" + eventId}, ${10}, ${"d" + eventId}, ${"content_hash"})`;
    await tx`update events set received_at = ${at} where id = ${eventId}`;
  });
  return { orgId, eventId };
}

/** A real destination the claim path FKs to. */
async function seedDestination(orgId: string): Promise<string> {
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into replay_destinations (id, org_id, url)
             values (${id}, ${orgId}, ${"https://x.test/dest"})`;
  });
  return id;
}

/** A raw dispatch row on `daysAgo`, with an explicit `billable`. Returns its id. */
async function seedDispatch(
  orgId: string,
  eventId: string,
  opts: { daysAgo?: number; billable?: boolean; status?: string } = {},
): Promise<string> {
  const { daysAgo = 0, billable = true, status = "queued" } = opts;
  const at = new Date(Date.UTC(2026, 6, 15) - daysAgo * DAY_MS + 7 * 3_600_000).toISOString();
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status, attempt, created_at, billable)
             values (${id}, ${orgId}, ${eventId}, ${"https://x.test"}, ${status}, ${1}, ${at}, ${billable})`;
  });
  return id;
}

async function billableOf(orgId: string, id: string): Promise<boolean> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ billable: boolean }[]>`
      select billable from delivery_attempts where id = ${id}`;
    return row!.billable;
  });
}

/** Roll one day exactly as runUsageRollup does — UTC-pinned, because rollup_usage's date_trunc('day', …)
 *  buckets in the SESSION timezone and would otherwise land the window on the wrong midnight. */
async function rollupDay(orgId: string, windowIso: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`set local time zone 'UTC'`;
    await tx`select rollup_usage(${windowIso}::timestamptz)`;
  });
}

async function usageCount(orgId: string, windowIso: string): Promise<number | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ event_count: string }[]>`
      select event_count::text from usage where window_start = ${windowIso}`;
    return row ? Number(row.event_count) : null;
  });
}

describe("delivery_attempts.billable — the rollup leg", () => {
  it("counts a billable dispatch and skips an unbillable one", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(1);
    await seedDispatch(orgId, eventId, { daysAgo: 1, billable: true });
    await seedDispatch(orgId, eventId, { daysAgo: 1, billable: true });
    await seedDispatch(orgId, eventId, { daysAgo: 1, billable: false });

    await rollupDay(orgId, dayIso(1));

    // 1 capture + 2 billable dispatches. The third dispatch is not work we did.
    expect(await usageCount(orgId, dayIso(1))).toBe(3);
  });

  it("still bills a RETRY exactly once — a retry updates its row, it never inserts another", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(1);
    const id = await seedDispatch(orgId, eventId, { daysAgo: 1 });
    await withTenant(
      app,
      orgId,
      (tx) => tx`update delivery_attempts set attempt = 5 where id = ${id}`,
    );

    await rollupDay(orgId, dayIso(1));

    expect(await usageCount(orgId, dayIso(1))).toBe(2); // 1 capture + 1 dispatch, not 5
  });
});

describe("delivery_attempts.billable — the live (soft-cap) leg", () => {
  it("sumPeriodEventUsage skips today's unbillable dispatches", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    await seedDispatch(orgId, eventId, { billable: true });
    await seedDispatch(orgId, eventId, { billable: false });
    await seedDispatch(orgId, eventId, { billable: false });

    const total = await withTenant(app, orgId, (tx) =>
      sumPeriodEventUsage(tx, { start: dayIso(30), end: null }, NOW),
    );
    expect(total).toBe(2); // 1 capture + 1 billable dispatch
  });
});

describe("recordDeliveryAttempt — the localhost tunnel forward", () => {
  it("writes billable = false: our Worker makes no outbound request", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const attempt = await withTenant(app, orgId, (tx) =>
      recordDeliveryAttempt(tx, {
        orgId,
        eventId,
        target: serializeTarget({ kind: "localhost-tunnel", sessionId: "sess-1" }),
        idempotencyKey: "k1",
        status: "forwarded",
      }),
    );

    expect(await billableOf(orgId, attempt.id)).toBe(false);

    // …and it therefore does not move the meter. `wbhk listen --forward` billed every webhook twice.
    const total = await withTenant(app, orgId, (tx) =>
      sumPeriodEventUsage(tx, { start: dayIso(30), end: null }, NOW),
    );
    expect(total).toBe(1); // the capture only
  });
});

describe("markDeliveryTerminalFailure — an SSRF-blocked delivery", () => {
  it("un-bills a `blocked` delivery: we refused to send the bytes", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const id = await seedDispatch(orgId, eventId, { status: "queued" });
    expect(await billableOf(orgId, id)).toBe(true);

    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id,
        destinationId: randomUUID(),
        status: "blocked",
        attempt: 1,
        statusCode: null,
        error: "destination url rejected at delivery",
      }),
    );

    expect(await billableOf(orgId, id)).toBe(false);
  });

  it("un-bills a `blocked` delivery via the claim → finalize path (remote replay)", async () => {
    // The SECOND un-billing site: apps/api/remote-replay + apps/web/replay-mutations claim a 'pending' row
    // and finalize it with the delivery outcome. A regression here would silently overcharge every remote
    // replay to a private/internal URL, while the DO drain path (markDeliveryTerminalFailure) stayed correct.
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const destinationId = await seedDestination(orgId);
    const { attempt, won } = await withTenant(app, orgId, (tx) =>
      claimDeliveryAttempt(tx, {
        orgId,
        eventId,
        destinationId,
        target: serializeTarget({ kind: "destination", destinationId }),
        idempotencyKey: "rr-1",
      }),
    );
    expect(won).toBe(true);
    expect(await billableOf(orgId, attempt.id)).toBe(true); // claimed as billable

    await withTenant(app, orgId, (tx) =>
      finalizeDeliveryAttempt(tx, {
        id: attempt.id,
        status: "blocked",
        statusCode: null,
        error: "destination url rejected at delivery",
      }),
    );

    expect(await billableOf(orgId, attempt.id)).toBe(false);
    // …and the meter reflects only the capture, not the refused dispatch.
    const total = await withTenant(app, orgId, (tx) =>
      sumPeriodEventUsage(tx, { start: dayIso(30), end: null }, NOW),
    );
    expect(total).toBe(1);
  });

  it("keeps a finalized `delivered` delivery billable", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const destinationId = await seedDestination(orgId);
    const { attempt } = await withTenant(app, orgId, (tx) =>
      claimDeliveryAttempt(tx, {
        orgId,
        eventId,
        destinationId,
        target: serializeTarget({ kind: "destination", destinationId }),
        idempotencyKey: "rr-2",
      }),
    );
    await withTenant(app, orgId, (tx) =>
      finalizeDeliveryAttempt(tx, { id: attempt.id, status: "delivered", statusCode: 200 }),
    );
    expect(await billableOf(orgId, attempt.id)).toBe(true);
  });

  it("keeps a `dead` delivery billable — we made every attempt, that is the work", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const id = await seedDispatch(orgId, eventId, { status: "queued" });

    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id,
        destinationId: randomUUID(),
        status: "dead",
        attempt: 8,
        statusCode: 503,
        error: "upstream down",
      }),
    );

    expect(await billableOf(orgId, id)).toBe(true);
  });
});

describe("the billable trigger — what keeps the F6 oracle a pure function", () => {
  it("refuses to raise billable back to true", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(0);
    const id = await seedDispatch(orgId, eventId, { billable: false });

    await expect(
      withTenant(
        app,
        orgId,
        (tx) => tx`update delivery_attempts set billable = true where id = ${id}`,
      ),
    ).rejects.toThrow(/billable/i);
  });

  it("silently declines to un-bill a dispatch whose day is already FINALIZED", async () => {
    // The pathological case: a dispatch created on a day that has since been frozen (its count is
    // immutable — money-guard F1) only now drains and is blocked. It was already billed; it stays billed.
    // Otherwise the F6 recount would undershoot the frozen count on that day, forever.
    const { orgId, eventId } = await seedOrgWithEvent(5);
    const id = await seedDispatch(orgId, eventId, { daysAgo: 5, status: "queued" });
    await rollupDay(orgId, dayIso(5));
    await withTenant(
      app,
      orgId,
      (tx) => tx`update usage set finalized_at = now() where window_start = ${dayIso(5)}`,
    );
    expect(await usageCount(orgId, dayIso(5))).toBe(2); // 1 capture + 1 dispatch, frozen

    await withTenant(app, orgId, (tx) =>
      markDeliveryTerminalFailure(tx, {
        id,
        destinationId: randomUUID(),
        status: "blocked",
        attempt: 1,
        statusCode: null,
        error: "destination url rejected at delivery",
      }),
    );

    // The status transitioned, but the billing decision for a frozen day is untouchable.
    expect(await billableOf(orgId, id)).toBe(true);
    const [row] = await provider<{ status: string }[]>`
      select status from delivery_attempts where id = ${id}`;
    expect(row!.status).toBe("blocked");
  });
});

describe("the F6 oracle — basis-aware recount", () => {
  async function reconcile() {
    return reconcileMeteringUsage({ audit, now: NOW, lookbackDays: 30, limit: 100 });
  }

  /** Freeze a day at `count` with an explicit metering basis. */
  async function freeze(
    orgId: string,
    windowIso: string,
    count: number,
    basis: { countsDeliveries: boolean; countsOnlyBillable: boolean },
  ): Promise<void> {
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into usage (org_id, window_start, event_count, finalized_at, counts_deliveries, counts_only_billable)
               values (${orgId}, ${windowIso}, ${count}, now(), ${basis.countsDeliveries}, ${basis.countsOnlyBillable})`;
    });
  }

  it("does not false-alarm on a day frozen BEFORE the billable split (it counted every dispatch)", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(3);
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: true });
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: false }); // e.g. a later-blocked delivery
    // The day was frozen under the OLD basis: 1 capture + BOTH dispatches.
    await freeze(orgId, dayIso(3), 3, { countsDeliveries: true, countsOnlyBillable: false });

    const result = await reconcile();
    expect(result.daysChecked).toBe(1);
    expect(result.mismatches).toEqual([]);
  });

  it("recounts a day frozen AFTER the split under the billable-only basis", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(3);
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: true });
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: false });
    await freeze(orgId, dayIso(3), 2, { countsDeliveries: true, countsOnlyBillable: true });

    const result = await reconcile();
    expect(result.mismatches).toEqual([]);
  });

  it("still ALARMS on real drift under the new basis", async () => {
    const { orgId, eventId } = await seedOrgWithEvent(3);
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: true });
    await freeze(orgId, dayIso(3), 99, { countsDeliveries: true, countsOnlyBillable: true });

    const result = await reconcile();
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ orgId, rollup: 99, recount: 2 });
  });

  it("rolls up and reconciles a fresh day with ZERO drift, end to end", async () => {
    // The invariant that matters: whatever rollup_usage froze, the independent recount reproduces.
    const { orgId, eventId } = await seedOrgWithEvent(3);
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: true });
    await seedDispatch(orgId, eventId, { daysAgo: 3, billable: false });
    await rollupDay(orgId, dayIso(3));
    await withTenant(
      app,
      orgId,
      (tx) => tx`update usage set finalized_at = now() where window_start = ${dayIso(3)}`,
    );

    expect(await usageCount(orgId, dayIso(3))).toBe(2);
    expect((await reconcile()).mismatches).toEqual([]);
  });
});
