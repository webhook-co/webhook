import { randomBytes, randomUUID } from "node:crypto";

import { CapabilityFault } from "@webhook-co/contract";
import { importAuditKey } from "@webhook-co/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { listDueDeliveries } from "../src/delivery";
import { deleteEventWithAudit } from "../src/event-delete";
import { reconcileMeteringUsage } from "../src/meter-reconcile";
import { sumPeriodEventUsage } from "../src/period-usage";
import { getEvent, listEvents, tailEvents } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// events.delete as a TOMBSTONE (S3). The load-bearing property: a user delete must NOT become a billing
// exploit or a metering-integrity break. A hard delete would (a) recompute the bill DOWN on the next rollup,
// (b) evade the live soft cap, (c) drift the F6 oracle, and (d) free the unique(endpoint_id, dedup_key) slot
// so the same webhook could be re-ingested and re-billed. The tombstone keeps the row — so this suite proves
// deleting an event changes NONE of the four — while making the event unreadable on every surface, redacting
// its captured PII in the tx, and enqueuing its R2 body for purge.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const DAY_MS = 86_400_000;

let pg: EphemeralPostgres;
let app: Sql;
let audit: Sql; // webhook_meter_audit — the F6 recount role
let admin: Sql;
let auditKey: CryptoKey;

function dayIso(daysAgo: number): string {
  return new Date(Date.UTC(2026, 6, 15) - daysAgo * DAY_MS).toISOString();
}

async function seedOrgWithEndpoint(): Promise<{ orgId: string; endpointId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at)
             values (${orgId}, ${orgId.slice(0, 8)}, ${"o"}, ${"2026-01-01T00:00:00Z"})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
  });
  return { orgId, endpointId };
}

/** Seed one event `daysAgo`, with PII-bearing content. Returns its id + dedup_key. */
async function seedEvent(
  orgId: string,
  endpointId: string,
  opts: { daysAgo?: number; dedupKey?: string } = {},
): Promise<{ eventId: string; dedupKey: string }> {
  const { daysAgo = 0, dedupKey = "dk-" + randomUUID() } = opts;
  const at = new Date(Date.UTC(2026, 6, 15) - daysAgo * DAY_MS + 6 * 3_600_000).toISOString();
  const eventId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into events
               (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, content_hash,
                headers, dedup_key, dedup_strategy, provider_event_id, external_id, verification, verified)
             values
               (${eventId}, ${orgId}, ${endpointId}, ${"org/" + orgId + "/ep/" + endpointId + "/k"}, ${10},
                ${"application/json"}, ${randomBytes(16)},
                ${tx.json([["authorization", "Bearer secret-token"]])},
                ${dedupKey}, ${"content_hash"}, ${"evt_123"}, ${"ext_abc"},
                ${tx.json({ ok: true, keyId: "key_1", scheme: "stripe" })}, ${true})`;
    await tx`update events set received_at = ${at} where id = ${eventId}`;
  });
  return { eventId, dedupKey };
}

function del(orgId: string, eventId: string) {
  return deleteEventWithAudit(app, { orgId, eventId, actor: "user-1" }, auditKey);
}

async function rollup(orgId: string, windowIso: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`set local time zone 'UTC'`;
    await tx`select rollup_usage(${windowIso}::timestamptz)`;
  });
}
async function usageCount(orgId: string, windowIso: string): Promise<number | null> {
  return withTenant(app, orgId, async (tx) => {
    const [r] = await tx<{ event_count: string }[]>`
      select event_count::text from usage where window_start = ${windowIso}`;
    return r ? Number(r.event_count) : null;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  audit = createClient(pg.urlFor({ role: DB_ROLES.meterAudit }));
  admin = createClient(pg.ownerUrl);
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
}, setupHookTimeoutMs());

afterAll(async () => {
  await Promise.all([app?.end(), audit?.end(), admin?.end()]);
  await pg?.stop();
});

afterEach(async () => {
  // audit_log is append-only WORM (a trigger blocks DELETE/TRUNCATE), and it's org-FK-decoupled (0051), so
  // it isn't cascade-cleaned — rows just accumulate. Each test uses a fresh random orgId, so per-org audit
  // chains never collide. Everything else truncates.
  await admin`truncate event_payload_purge, delivery_attempts, events, endpoints, usage, orgs cascade`;
});

describe("the money-integrity invariants (non-negotiable)", () => {
  it("deleting today's events does NOT reduce the live soft-cap sum", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const a = await seedEvent(orgId, endpointId);
    await seedEvent(orgId, endpointId);

    const before = await withTenant(app, orgId, (tx) =>
      sumPeriodEventUsage(tx, { start: dayIso(30), end: null }, NOW),
    );
    await del(orgId, a.eventId);
    const after = await withTenant(app, orgId, (tx) =>
      sumPeriodEventUsage(tx, { start: dayIso(30), end: null }, NOW),
    );
    expect(before).toBe(2);
    expect(after).toBe(2); // the tombstone is still a captured, billed event
  });

  it("deleting events does NOT reduce the daily rollup count", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const a = await seedEvent(orgId, endpointId, { daysAgo: 1 });
    await seedEvent(orgId, endpointId, { daysAgo: 1 });
    await del(orgId, a.eventId);

    await rollup(orgId, dayIso(1));
    expect(await usageCount(orgId, dayIso(1))).toBe(2); // both still counted
  });

  it("does NOT drift the F6 reconciliation oracle on a frozen day", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    await seedEvent(orgId, endpointId, { daysAgo: 3 });
    const b = await seedEvent(orgId, endpointId, { daysAgo: 3 });
    await rollup(orgId, dayIso(3));
    await withTenant(
      app,
      orgId,
      (tx) => tx`update usage set finalized_at = now() where window_start = ${dayIso(3)}`,
    );
    // Delete AFTER the day froze — the recount must still match the frozen count (tombstone still counts).
    await del(orgId, b.eventId);

    const result = await reconcileMeteringUsage({ audit, now: NOW, lookbackDays: 30, limit: 100 });
    expect(result.mismatches).toEqual([]);
  });

  it("does NOT free the dedup slot — the same webhook cannot be re-ingested (and re-billed)", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const { eventId, dedupKey } = await seedEvent(orgId, endpointId);
    await del(orgId, eventId);

    // A fresh insert reusing (endpoint_id, dedup_key) must still hit the unique constraint — the tombstone
    // occupies the slot, so a redelivery of the same webhook can't mint a second billable row.
    await expect(
      withTenant(
        app,
        orgId,
        (tx) =>
          tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
           values (${randomUUID()}, ${orgId}, ${endpointId}, ${"k2"}, ${10}, ${dedupKey}, ${"content_hash"})`,
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("the event becomes unreadable on every surface", () => {
  it("getEvent, listEvents, and tailEvents all hide a tombstoned event", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const keep = await seedEvent(orgId, endpointId);
    const gone = await seedEvent(orgId, endpointId);
    // tailEvents filters on a now()-relative gapless watermark, so both rows must sit safely in the real
    // past (the metering tests' fake 2026-07-15 frame is FUTURE vs the DB clock). Backdate an hour.
    await withTenant(
      app,
      orgId,
      (tx) => tx`update events set received_at = now() - interval '1 hour'`,
    );
    await del(orgId, gone.eventId);

    await withTenant(app, orgId, async (tx) => {
      expect(await getEvent(tx, gone.eventId)).toBeNull(); // direct fetch → gone
      expect(await getEvent(tx, keep.eventId)).not.toBeNull(); // sibling untouched
      const list = await listEvents(tx, { endpointId, limit: 50 });
      expect(list.items.map((e) => e.id)).toEqual([keep.eventId]);
      const tail = await tailEvents(tx, { endpointId, limit: 50 });
      expect(tail.items.map((e) => e.id)).toEqual([keep.eventId]);
    });
  });
});

describe("in-tx PII redaction + R2 purge enqueue", () => {
  it("redacts the captured content and enqueues the R2 body for purge", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const { eventId } = await seedEvent(orgId, endpointId);
    await del(orgId, eventId);

    const [row] = await admin<
      {
        headers: unknown;
        verification: unknown;
        external_id: string | null;
        provider_event_id: string | null;
        content_hash: Buffer | null;
        content_type: string | null;
        dedup_key: string | null;
        payload_r2_key: string;
      }[]
    >`select headers, verification, external_id, provider_event_id, content_hash, content_type,
             dedup_key, payload_r2_key from events where id = ${eventId}`;
    expect(row.headers).toEqual([]); // the Authorization header is gone
    expect(row.verification).toBeNull();
    expect(row.external_id).toBeNull();
    expect(row.provider_event_id).toBeNull();
    expect(row.content_hash).toBeNull();
    expect(row.content_type).toBeNull();
    expect(row.dedup_key).not.toBeNull(); // KEPT — anti-re-bill
    expect(row.payload_r2_key).not.toBeNull(); // KEPT — needed to enqueue the purge

    const [purge] = await admin<{ payload_r2_key: string; status: string; endpoint_id: string }[]>`
      select payload_r2_key, status, endpoint_id from event_payload_purge where event_id = ${eventId}`;
    expect(purge.status).toBe("purging");
    expect(purge.endpoint_id).toBe(endpointId);
    expect(purge.payload_r2_key).toBe(row.payload_r2_key); // the exact object to delete
  });
});

describe("delivery interaction — a tombstoned event is never POSTed", () => {
  it("a queued delivery for a deleted event becomes NON-deliverable (drain refuses it, no body sent)", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const { eventId } = await seedEvent(orgId, endpointId);
    const destId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into replay_destinations (id, org_id, url) values (${destId}, ${orgId}, ${"https://x.test"})`;
      await tx`insert into delivery_attempts (id, org_id, event_id, destination_id, target, status)
               values (${randomUUID()}, ${orgId}, ${eventId}, ${destId}, ${"https://x.test"}, ${"queued"})`;
    });

    // Before delete: the queued delivery is due AND deliverable.
    const before = await withTenant(app, orgId, (tx) => listDueDeliveries(tx, destId));
    expect(before).toHaveLength(1);
    expect(before[0]!.deliverable).toBe(true);

    await del(orgId, eventId);

    // After delete: the row is still returned (so the drain can terminally refuse it) but NOT deliverable —
    // the drain's `!deliverable` path records it blocked, never POSTing the redacted body.
    const after = await withTenant(app, orgId, (tx) => listDueDeliveries(tx, destId));
    expect(after).toHaveLength(1);
    expect(after[0]!.deliverable).toBe(false);
  });
});

describe("audit + idempotency + not-found", () => {
  it("appends exactly one audit row and is idempotent on re-delete", async () => {
    const { orgId, endpointId } = await seedOrgWithEndpoint();
    const { eventId } = await seedEvent(orgId, endpointId);

    const first = await del(orgId, eventId);
    expect(first.wasLive).toBe(true);
    const second = await del(orgId, eventId);
    expect(second.wasLive).toBe(false); // idempotent no-op
    expect(second.deletedAt.getTime()).toBe(first.deletedAt.getTime()); // time preserved

    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(chain.filter((r) => r.action === "event.deleted")).toHaveLength(1); // audited once
    const [purgeCount] = await admin<{ n: number }[]>`
      select count(*)::int as n from event_payload_purge where event_id = ${eventId}`;
    expect(purgeCount.n).toBe(1); // no duplicate purge job
  });

  it("throws NOT_FOUND for an unknown or cross-org id", async () => {
    const { orgId } = await seedOrgWithEndpoint();
    await expect(del(orgId, randomUUID())).rejects.toBeInstanceOf(CapabilityFault);
  });
});
