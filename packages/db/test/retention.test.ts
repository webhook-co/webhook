import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { claimRetentionOrgs, deleteExpiredEvents, listExpiringEvents } from "../src/retention";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Drives the retention-prune DAL against a real Postgres so the cross-org `webhook_retention` role's
// policies + column grants (0053) are exercised for real: the aged-event enumeration, the entitled-org
// exclusion, the R2-key read, and the age-FLOOR DELETE policy that must refuse to remove an in-retention
// event even when its id is handed straight to the delete.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — seeds orgs/endpoints/events under RLS
let admin: Sql; // superuser — seeds the SELECT-only billing_subscriptions
let retention: Sql; // webhook_retention — the DAL under test (cross-org)

const RETENTION_DAYS = 7;

/** Seed an org + owner endpoint; returns { orgId, endpointId }. */
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

async function seedSubscription(orgId: string, status: string): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 8)}, ${"price_pro"}, ${status}, now(), now() + interval '30 days')`;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  admin = createClient(pg.ownerUrl);
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

    const orgs = await claimRetentionOrgs(retention, RETENTION_DAYS, 100);
    expect(orgs).toContain(stale.orgId);
    expect(orgs).not.toContain(fresh.orgId);
  });

  it("EXCLUDES orgs entitled to a paid plan (active/trialing/past_due), so paying customers aren't pruned", async () => {
    for (const status of ["active", "trialing", "past_due"]) {
      const paid = await seedOrg(`paid-${status}`);
      await seedEvent(paid.orgId, paid.endpointId, { ageDays: 30 });
      await seedSubscription(paid.orgId, status);
      const orgs = await claimRetentionOrgs(retention, RETENTION_DAYS, 100);
      expect(orgs).not.toContain(paid.orgId);
    }
  });

  it("INCLUDES an org whose subscription is NON-entitled (e.g. canceled) — it is back on the Free window", async () => {
    const churned = await seedOrg("churned");
    await seedEvent(churned.orgId, churned.endpointId, { ageDays: 30 });
    await seedSubscription(churned.orgId, "canceled");
    const orgs = await claimRetentionOrgs(retention, RETENTION_DAYS, 100);
    expect(orgs).toContain(churned.orgId);
  });
});

describe("listExpiringEvents", () => {
  it("returns only the aged events, with their content-addressed R2 key, and respects the limit", async () => {
    const o = await seedOrg("list");
    const oldA = await seedEvent(o.orgId, o.endpointId, { ageDays: 10, r2Key: "key-A" });
    const oldB = await seedEvent(o.orgId, o.endpointId, { ageDays: 9, r2Key: "key-B" });
    await seedEvent(o.orgId, o.endpointId, { ageDays: 1 }); // in-retention — must not appear

    const page = await listExpiringEvents(retention, o.orgId, RETENTION_DAYS, 100);
    expect(page.map((e) => e.id).sort()).toEqual([oldA, oldB].sort());
    expect(page.map((e) => e.r2Key).sort()).toEqual(["key-A", "key-B"]);

    const limited = await listExpiringEvents(retention, o.orgId, RETENTION_DAYS, 1);
    expect(limited).toHaveLength(1);
  });
});

describe("deleteExpiredEvents", () => {
  it("deletes the aged events by id, cascades their delivery_attempts, and returns the count", async () => {
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
    expect(deleted).toBe(1);

    const [{ n: events }] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${oldId}`;
    expect(events).toBe(0);
    const [{ n: attempts }] = await admin<
      { n: number }[]
    >`select count(*)::int as n from delivery_attempts where event_id = ${oldId}`;
    expect(attempts).toBe(0);
  });

  it("is a no-op for an empty id list", async () => {
    const o = await seedOrg("empty");
    expect(await deleteExpiredEvents(retention, o.orgId, [])).toBe(0);
  });

  it("the age-FLOOR DELETE policy REFUSES to remove an in-retention event even if its id is passed", async () => {
    // Defense in depth: the role-targeted DELETE policy USING (received_at < now() - 7d) means a bug that
    // hands a fresh event's id to the delete removes NOTHING — RLS filters it out (0 rows), never an error.
    const o = await seedOrg("floor");
    const freshId = await seedEvent(o.orgId, o.endpointId, { ageDays: 1 });
    const deleted = await deleteExpiredEvents(retention, o.orgId, [freshId]);
    expect(deleted).toBe(0);
    const [{ n }] = await admin<
      { n: number }[]
    >`select count(*)::int as n from events where id = ${freshId}`;
    expect(n).toBe(1); // still there
  });
});

describe("webhook_retention least privilege", () => {
  it("holds SELECT on only the enumeration/purge columns of events + DELETE, no other write", async () => {
    const granted = ["id", "org_id", "received_at", "payload_r2_key"] as const;
    for (const c of granted) {
      const [p] = await admin<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.retention}, 'events', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    const denied = ["headers", "dedup_key", "verification", "content_hash"] as const;
    for (const c of denied) {
      const [p] = await admin<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.retention}, 'events', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    const [w] = await admin<{ del: boolean; ins: boolean; upd: boolean }[]>`
      select has_table_privilege(${DB_ROLES.retention}, 'events', 'DELETE') as del,
             has_table_privilege(${DB_ROLES.retention}, 'events', 'INSERT') as ins,
             has_table_privilege(${DB_ROLES.retention}, 'events', 'UPDATE') as upd`;
    expect(w).toEqual({ del: true, ins: false, upd: false });
  });

  it("reads ONLY (org_id, status) on billing_subscriptions — never the plan/price id, and no write", async () => {
    const [g] = await admin<{ orgId: boolean; status: boolean; plan: boolean; ins: boolean }[]>`
      select has_column_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'org_id', 'SELECT') as "orgId",
             has_column_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'status', 'SELECT') as status,
             has_column_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'plan', 'SELECT') as plan,
             has_table_privilege(${DB_ROLES.retention}, 'billing_subscriptions', 'INSERT') as ins`;
    expect(g).toEqual({ orgId: true, status: true, plan: false, ins: false });
  });

  it("holds no privilege on identity/tenant tables it has no business touching", async () => {
    for (const table of ["orgs", "api_keys", "audit_log", "provider_secrets"]) {
      const [p] = await admin<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.retention}, ${table}, 'SELECT')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'INSERT')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.retention}, ${table}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
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
    expect(owned.n).toBe(0);
  });
});
