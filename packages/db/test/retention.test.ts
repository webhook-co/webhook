import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { existingPayloadKeys } from "../src/orphan-sweep";
import { claimRetentionOrgs, deleteExpiredEvents, listExpiringEvents } from "../src/retention";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Drives the retention-prune DAL against a real Postgres so the cross-org `webhook_retention` role's policies
// + column grants (0053/0054) are exercised for real: the aged-event enumeration, the PER-PLAN window, the
// R2-key read, and the DELETE policy that must refuse to remove an event still inside its org's window even
// when its id is handed straight to the delete.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — seeds orgs/endpoints/events under RLS
let admin: Sql; // superuser — seeds the SELECT-only billing_subscriptions
let retention: Sql; // webhook_retention — the DAL under test (cross-org)

/** Set an org's retention window. NULL = unlimited (never pruned) — e.g. an Enterprise contract. */
async function setRetentionDays(orgId: string, days: number | null): Promise<void> {
  await admin`update orgs set retention_days = ${days} where id = ${orgId}`;
}

/** Seed an org + owner endpoint; returns { orgId, endpointId }. */
// Seed a FREE org (retention_days = 7). Set EXPLICITLY, because the column default is now NULL = unlimited
// (0056, the fail-safe against pruning an unmirrored paid org) — bootstrapPersonalOrg writes the Free window
// itself, and so must these prune fixtures, which model free orgs.
async function seedOrg(slug: string): Promise<{ orgId: string; endpointId: string }> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, retention_days) values (${orgId}, ${slug}, ${slug}, ${7})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
  });
  return { orgId, endpointId };
}

/** Seed one event with an exact age (received_at is trigger-stamped on INSERT, then overwritten). */
async function seedEvent(
  orgId: string,
  endpointId: string,
  opts: { ageDays: number; r2Key?: string },
): Promise<string> {
  const id = randomUUID();
  const r2Key = opts.r2Key ?? `org/${orgId}/ep/${endpointId}/${id}`;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${id}, ${orgId}, ${endpointId}, ${r2Key}, ${10}, ${"d" + id}, ${"content_hash"})`;
    await tx`update events set received_at = now() - (${opts.ageDays} * interval '1 day') where id = ${id}`;
  });
  return id;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  admin = createClient(pg.providerUrl);
  retention = createClient(pg.urlFor({ role: DB_ROLES.retention }));
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from delivery_attempts`;
  await admin`delete from events`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from endpoints`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await retention?.end();
  await pg?.stop();
});

describe("claimRetentionOrgs", () => {
  it("returns orgs with events older than the window, and not orgs with only fresh events", async () => {
    const stale = await seedOrg("stale");
    await seedEvent(stale.orgId, stale.endpointId, { ageDays: 10 });
    const fresh = await seedOrg("fresh");
    await seedEvent(fresh.orgId, fresh.endpointId, { ageDays: 2 });

    const orgs = await claimRetentionOrgs(retention, 100);
    expect(orgs).toContain(stale.orgId);
    expect(orgs).not.toContain(fresh.orgId);
  });

  it("does NOT claim a paid org whose data is still inside its longer window", async () => {
    // 0053 skipped paid orgs entirely (over-retaining forever). Now they simply have a longer window: a Pro
    // org's 10-day-old event is past the Free 7 but well inside Pro's 30, so there is nothing to prune.
    const pro = await seedOrg("claim-pro-inwindow");
    await setRetentionDays(pro.orgId, 30);
    await seedEvent(pro.orgId, pro.endpointId, { ageDays: 10 });
    expect(await claimRetentionOrgs(retention, 100)).not.toContain(pro.orgId);
  });

  it("DOES claim a paid org once its data ages past its own (longer) window", async () => {
    // The whole point of 0054: a Pro org's data is not kept forever — it is pruned at 30 days.
    const pro = await seedOrg("claim-pro-expired");
    await setRetentionDays(pro.orgId, 30);
    await seedEvent(pro.orgId, pro.endpointId, { ageDays: 40 });
    expect(await claimRetentionOrgs(retention, 100)).toContain(pro.orgId);
  });

  it("claims a CHURNED org at the Free window (billing-sync resets retention_days on cancellation)", async () => {
    const churned = await seedOrg("churned");
    await setRetentionDays(churned.orgId, 7); // what applySubscriptionDeleted writes
    await seedEvent(churned.orgId, churned.endpointId, { ageDays: 30 });
    expect(await claimRetentionOrgs(retention, 100)).toContain(churned.orgId);
  });
});

describe("listExpiringEvents", () => {
  it("returns only the aged events, with their content-addressed R2 key, and respects the limit", async () => {
    const o = await seedOrg("list");
    const oldA = await seedEvent(o.orgId, o.endpointId, { ageDays: 10, r2Key: "key-A" });
    const oldB = await seedEvent(o.orgId, o.endpointId, { ageDays: 9, r2Key: "key-B" });
    await seedEvent(o.orgId, o.endpointId, { ageDays: 1 }); // in-retention — must not appear

    const page = await listExpiringEvents(retention, o.orgId, 100);
    expect(page.map((e) => e.id).sort()).toEqual([oldA, oldB].sort());
    expect(page.map((e) => e.r2Key).sort()).toEqual(["key-A", "key-B"]);
    // endpoint_id rides along so the cron can fence the key to org/{org}/ep/{endpoint}/ before deleting.
    expect(page.every((e) => e.endpointId === o.endpointId)).toBe(true);

    const limited = await listExpiringEvents(retention, o.orgId, 1);
    expect(limited).toHaveLength(1);
  });

  it("spares data when the org's window LENGTHENS after the claim (an upgrade lands mid-tick)", async () => {
    // Defence at list time, not just claim time. The org was claimed on the Free window; by the time we list,
    // they have upgraded to Pro (30 days) and their 10-day-old event is no longer expired. Re-reading the
    // window in the list is what stops us pruning data the customer now pays to keep.
    const o = await seedOrg("list-upgraded");
    await seedEvent(o.orgId, o.endpointId, { ageDays: 10 });
    await setRetentionDays(o.orgId, 30); // upgrade lands mid-tick
    expect(await listExpiringEvents(retention, o.orgId, 100)).toEqual([]);
  });
});

describe("deleteExpiredEvents", () => {
  it("deletes the aged events by id, cascades their delivery_attempts, and returns the deleted ids", async () => {
    const o = await seedOrg("del");
    const oldId = await seedEvent(o.orgId, o.endpointId, { ageDays: 10 });
    // A delivery attempt on the aged event — must cascade away with it (FK ON DELETE CASCADE).
    await withTenant(
      app,
      o.orgId,
      (tx) => tx`insert into delivery_attempts (id, org_id, event_id, target, status)
                 values (${randomUUID()}, ${o.orgId}, ${oldId}, ${"https://x.test"}, ${"pending"})`,
    );

    const deleted = await deleteExpiredEvents(retention, o.orgId, [oldId]);
    expect(deleted).toEqual([oldId]);

    const [eventsRow] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${oldId}`;
    expect(eventsRow!.n).toBe(0);
    const [attemptsRow] = await admin<
      { n: number }[]
    >`select count(*)::int as n from delivery_attempts where event_id = ${oldId}`;
    expect(attemptsRow!.n).toBe(0);
  });

  it("is a no-op for an empty id list", async () => {
    const o = await seedOrg("empty");
    expect(await deleteExpiredEvents(retention, o.orgId, [])).toEqual([]);
  });

  it("is scoped to the passed org — another org's id is never deleted through the wrong org", async () => {
    const a = await seedOrg("scope-a");
    const idA = await seedEvent(a.orgId, a.endpointId, { ageDays: 30 });
    const b = await seedOrg("scope-b");
    // Ask to delete A's event but under B's org — the `where org_id = $b` predicate spares it.
    expect(await deleteExpiredEvents(retention, b.orgId, [idA])).toEqual([]);
    const [row] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${idA}`;
    expect(row!.n).toBe(1);
  });

  it("the age-FLOOR DELETE policy REFUSES to remove an in-retention event even if its id is passed", async () => {
    // Defense in depth: the role-targeted DELETE policy USING (received_at < now() - 7d) means a bug that
    // hands a fresh event's id to the delete removes NOTHING — RLS filters it out (0 rows), never an error.
    const o = await seedOrg("floor");
    const freshId = await seedEvent(o.orgId, o.endpointId, { ageDays: 1 });
    const deleted = await deleteExpiredEvents(retention, o.orgId, [freshId]);
    expect(deleted).toEqual([]);
    const [row] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${freshId}`;
    expect(row!.n).toBe(1); // still there
  });

  it("the RLS DELETE POLICY blocks a bare cross-org delete of a PAID org's data inside its window", async () => {
    // Defence-in-depth at the DB, not just the DAL's WHERE clause. A leaked webhook_retention credential
    // running `delete from events where received_at < now()-7d` — i.e. asserting the FREE window against
    // everyone — must not remove a Pro org's 20-day-old event. The policy uses the org's OWN window.
    const pro = await seedOrg("policy-pro");
    await setRetentionDays(pro.orgId, 30);
    const proInWindow = await seedEvent(pro.orgId, pro.endpointId, { ageDays: 20 });
    const free = await seedOrg("policy-free");
    const freeOld = await seedEvent(free.orgId, free.endpointId, { ageDays: 30 });

    const removed = await retention<{ id: string }[]>`
      delete from events where received_at < now() - interval '7 days' returning id`;
    const removedIds = removed.map((r) => r.id);
    expect(removedIds).toContain(freeOld); // past the Free org's window → removable
    expect(removedIds).not.toContain(proInWindow); // inside Pro's 30 days → the policy spares it
    const [row] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${proInWindow}`;
    expect(row!.n).toBe(1);
  });

  it("REFUSES to delete an event whose org UPGRADED mid-tick, even if its id is passed (atomic re-check)", async () => {
    // The catastrophic miss: destroying data a customer now pays to keep. If the window lengthens between the
    // id list and the delete, the DELETE re-reads it and removes nothing.
    const o = await seedOrg("del-upgraded");
    const oldId = await seedEvent(o.orgId, o.endpointId, { ageDays: 10 }); // expired on Free
    await setRetentionDays(o.orgId, 30); // upgrade lands between list and delete
    const deleted = await deleteExpiredEvents(retention, o.orgId, [oldId]);
    expect(deleted).toEqual([]);
    const [row] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${oldId}`;
    expect(row!.n).toBe(1); // survives
  });
});

describe("claimRetentionOrgs fairness", () => {
  it("returns oldest-data orgs first, so a backlog larger than the limit can't starve an org", async () => {
    const older = await seedOrg("older");
    await seedEvent(older.orgId, older.endpointId, { ageDays: 40 });
    const newer = await seedOrg("newer");
    await seedEvent(newer.orgId, newer.endpointId, { ageDays: 10 });

    // limit 1 must pick the org whose oldest event is furthest past the window.
    expect(await claimRetentionOrgs(retention, 1)).toEqual([older.orgId]);
  });
});

describe("webhook_retention least privilege", () => {
  it("holds SELECT on only the enumeration/purge columns of events + DELETE, no other write", async () => {
    const granted = ["id", "org_id", "endpoint_id", "received_at", "payload_r2_key"] as const;
    for (const c of granted) {
      const [p] = await admin<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.retention}, 'events', ${c}, 'SELECT') as ok`;
      expect(p!.ok).toBe(true);
    }
    const denied = ["headers", "dedup_key", "verification", "content_hash"] as const;
    for (const c of denied) {
      const [p] = await admin<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.retention}, 'events', ${c}, 'SELECT') as ok`;
      expect(p!.ok).toBe(false);
    }
    const [w] = await admin<{ del: boolean; ins: boolean; upd: boolean }[]>`
      select has_table_privilege(${DB_ROLES.retention}, 'events', 'DELETE') as del,
             has_table_privilege(${DB_ROLES.retention}, 'events', 'INSERT') as ins,
             has_table_privilege(${DB_ROLES.retention}, 'events', 'UPDATE') as upd`;
    expect(w).toEqual({ del: true, ins: false, upd: false });
  });

  it("reads ONLY (id, retention_days) on orgs — never the org's name/slug — and cannot write it", async () => {
    const [g] = await admin<{ id: boolean; days: boolean; name: boolean; upd: boolean }[]>`
      select has_column_privilege(${DB_ROLES.retention}, 'orgs', 'id', 'SELECT') as id,
             has_column_privilege(${DB_ROLES.retention}, 'orgs', 'retention_days', 'SELECT') as days,
             has_column_privilege(${DB_ROLES.retention}, 'orgs', 'name', 'SELECT') as name,
             has_table_privilege(${DB_ROLES.retention}, 'orgs', 'UPDATE') as upd`;
    expect(g).toEqual({ id: true, days: true, name: false, upd: false });
  });

  it("has NO access to billing_subscriptions at all — the window comes from orgs, not subscription state", async () => {
    // 0054 revoked it. This role has no business knowing who pays us.
    const [g] = await admin<{ sel: boolean; ins: boolean }[]>`
      select has_column_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'status', 'SELECT') as sel,
             has_table_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'INSERT') as ins`;
    expect(g).toEqual({ sel: false, ins: false });
  });

  it("holds no privilege on identity/tenant tables it has no business touching", async () => {
    for (const table of ["orgs", "api_keys", "audit_log", "provider_secrets"]) {
      const [p] = await admin<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.retention}, ${table}, 'SELECT')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'INSERT')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'DELETE')) as any`;
      expect(p!.any).toBe(false);
    }
  });

  it("is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    const [r] = await admin<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = ${DB_ROLES.retention}`;
    expect(r).toEqual({ super: false, bypass: false });
    const [owned] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.retention}`;
    expect(owned!.n).toBe(0);
  });
});

// ── Per-plan windows (0054) ──────────────────────────────────────────────────────────────────────────────
// 0053 pruned everyone at 7 days and skipped paid orgs entirely, so Pro/Scale data was kept forever while
// the pricing page advertised 30/90-day windows. The window is now the org's own.

describe("per-plan retention windows", () => {
  it("prunes a PRO org at 30 days, not at the Free 7", async () => {
    const { orgId, endpointId } = await seedOrg("pro-window");
    await setRetentionDays(orgId, 30);
    const inWindow = await seedEvent(orgId, endpointId, { ageDays: 20 }); // still covered by Pro
    const expired = await seedEvent(orgId, endpointId, { ageDays: 40 }); // past 30 days

    const found = await listExpiringEvents(retention, orgId, 100);
    expect(found.map((e) => e.id)).toEqual([expired]);

    // Hand BOTH ids to the delete: the 20-day-old one must survive — the window is re-asserted in the
    // DELETE itself, so a stale id list can't remove data the org's plan still covers.
    const deleted = await deleteExpiredEvents(retention, orgId, [inWindow, expired]);
    expect(deleted).toEqual([expired]);
  });

  it("prunes a SCALE org at 90 days", async () => {
    const { orgId, endpointId } = await seedOrg("scale-window");
    await setRetentionDays(orgId, 90);
    await seedEvent(orgId, endpointId, { ageDays: 60 }); // in window
    const expired = await seedEvent(orgId, endpointId, { ageDays: 120 });

    expect((await listExpiringEvents(retention, orgId, 100)).map((e) => e.id)).toEqual([expired]);
  });

  it("NEVER prunes an org on an unlimited window (retention_days NULL) — not even a very old event", async () => {
    // Enterprise / contractual retention. NULL * interval → NULL, so the predicate is never true. Proven
    // through the DAL *and* through a bare cross-org DELETE below.
    const { orgId, endpointId } = await seedOrg("unlimited-window");
    await setRetentionDays(orgId, null);
    const ancient = await seedEvent(orgId, endpointId, { ageDays: 3650 });

    expect(await listExpiringEvents(retention, orgId, 100)).toEqual([]);
    expect(await deleteExpiredEvents(retention, orgId, [ancient])).toEqual([]);
    expect(await claimRetentionOrgs(retention, 100)).not.toContain(orgId);
  });

  it("an org created with the Free 7-day window prunes events past it", async () => {
    // seedOrg writes retention_days = 7 explicitly, exactly as bootstrapPersonalOrg now does for a free org.
    const { orgId, endpointId } = await seedOrg("free-window");
    const expired = await seedEvent(orgId, endpointId, { ageDays: 10 });
    await seedEvent(orgId, endpointId, { ageDays: 3 });

    expect((await listExpiringEvents(retention, orgId, 100)).map((e) => e.id)).toEqual([expired]);
  });

  it("FAIL-SAFE: an org inserted with NO window (the NULL default, 0056) is NEVER pruned", async () => {
    // The whole point of flipping the column default to NULL: a row that reaches the prune with an unset
    // window — e.g. a paid org whose subscription hasn't mirrored yet — must OVER-retain, not be deleted at
    // the Free window on day 8. Insert an org WITHOUT retention_days and prove nothing prunes it.
    const orgId = randomUUID();
    const endpointId = randomUUID();
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${"nulldefault"}, ${"nulldefault"})`;
      await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
               values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    });
    const ancient = await seedEvent(orgId, endpointId, { ageDays: 3650 });

    expect(await listExpiringEvents(retention, orgId, 100)).toEqual([]);
    expect(await deleteExpiredEvents(retention, orgId, [ancient])).toEqual([]);
    expect(await claimRetentionOrgs(retention, 100)).not.toContain(orgId);
  });

  it("claims each org against its OWN window, oldest-data-first", async () => {
    const free = await seedOrg("claim-free");
    const pro = await seedOrg("claim-pro");
    await setRetentionDays(pro.orgId, 30);
    // 10 days old: PAST the Free window, but well INSIDE Pro's. Only the free org is claimable.
    await seedEvent(free.orgId, free.endpointId, { ageDays: 10 });
    await seedEvent(pro.orgId, pro.endpointId, { ageDays: 10 });

    const claimed = await claimRetentionOrgs(retention, 100);
    expect(claimed).toContain(free.orgId);
    expect(claimed).not.toContain(pro.orgId);
  });

  it("THE SECURITY BOUNDARY: a bare cross-org DELETE as webhook_retention still respects every org's window", async () => {
    // The RLS DELETE policy — not the app's WHERE clause — is what a leaked credential runs into. A raw
    // `delete from events` must not remove a Pro org's 20-day-old event, nor anything from an unlimited org.
    const pro = await seedOrg("boundary-pro");
    const ent = await seedOrg("boundary-ent");
    const free = await seedOrg("boundary-free");
    await setRetentionDays(pro.orgId, 30);
    await setRetentionDays(ent.orgId, null);

    const proInWindow = await seedEvent(pro.orgId, pro.endpointId, { ageDays: 20 });
    const entAncient = await seedEvent(ent.orgId, ent.endpointId, { ageDays: 3650 });
    const freeExpired = await seedEvent(free.orgId, free.endpointId, { ageDays: 10 });

    const removed = await retention<{ id: string }[]>`delete from events returning id`;
    const removedIds = removed.map((r) => r.id);

    expect(removedIds).toContain(freeExpired); // past its window → fair game
    expect(removedIds).not.toContain(proInWindow); // inside Pro's 30 days → policy refuses
    expect(removedIds).not.toContain(entAncient); // unlimited → policy refuses, at any age
  });
});

// The orphan-sweep anti-join (S6c-iii): under the SAME cross-org webhook_retention role, resolve which of a
// batch of R2 keys have an events row. The sweep deletes the complement (the orphans).
describe("existingPayloadKeys (orphan-sweep anti-join)", () => {
  it("returns the CROSS-ORG subset of keys that have an events row; the rest are orphans", async () => {
    const a = await seedOrg("org-a");
    const b = await seedOrg("org-b");
    const keyA = `org/${a.orgId}/ep/${a.endpointId}/${"a".repeat(64)}`;
    const keyB = `org/${b.orgId}/ep/${b.endpointId}/${"b".repeat(64)}`;
    await seedEvent(a.orgId, a.endpointId, { ageDays: 1, r2Key: keyA });
    await seedEvent(b.orgId, b.endpointId, { ageDays: 1, r2Key: keyB });

    const orphanKey = `org/${a.orgId}/ep/${a.endpointId}/${"c".repeat(64)}`; // no row for this one
    const existing = await existingPayloadKeys(retention, [keyA, keyB, orphanKey]);

    expect(existing.has(keyA)).toBe(true); // org A's row — spanning orgs in one query
    expect(existing.has(keyB)).toBe(true); // org B's row
    expect(existing.has(orphanKey)).toBe(false); // no row → the sweep would delete it
  });

  it("still counts a TOMBSTONED event's key as existing (its body is the purge cron's job, not an orphan)", async () => {
    const o = await seedOrg("org-t");
    const key = `org/${o.orgId}/ep/${o.endpointId}/${"d".repeat(64)}`;
    const id = await seedEvent(o.orgId, o.endpointId, { ageDays: 1, r2Key: key });
    await admin`update events set deleted_at = now() where id = ${id}`; // soft-delete (tombstone)

    const existing = await existingPayloadKeys(retention, [key]);
    expect(existing.has(key)).toBe(true); // row still present → NOT an orphan
  });

  it("returns an empty set for no keys (no query)", async () => {
    expect((await existingPayloadKeys(retention, [])).size).toBe(0);
  });
});
