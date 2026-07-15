import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  clearFreeCapGrace,
  flagOrgForFreeCapGrace,
  restoreOrgFromFreeCap,
  suspendOrgForFreeCap,
} from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The free-org-cap reconciler's WRITE side (PR2b slice 3a): flag-grace / suspend / restore, run as
// webhook_capreconciler CROSS-ORG (no tenant GUC — the role-targeted UPDATE policies from 0085 grant the
// reach). Driven against real Postgres so those policies + column grants gate exactly as production does.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let admin: Sql;
let reconciler: Sql;

async function seedOrg(): Promise<string> {
  const uid = randomUUID();
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${uid}, ${uid}, ${`${uid}@t.test`}, ${true}, now())`;
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "o",
    ownerUserId: uid,
    auditKey: await testAuditKey(),
  });
  return id;
}

/** Read the org's suspend state (admin bypasses RLS). */
async function orgState(orgId: string) {
  const [r] = await admin<
    { status: string; reason: string | null; grace: Date | null; restore: Date | null }[]
  >`select status, suspended_reason as reason, free_org_cap_grace_until as grace,
           restore_deadline as restore from orgs where id = ${orgId}`;
  return r!;
}

/** Read the org's ingest_paused row (admin). */
async function pauseState(orgId: string) {
  const [r] = await admin<{ paused: boolean; reason: string | null }[]>`
    select paused, reason from ingest_paused where org_id = ${orgId}`;
  return r ?? null;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
  reconciler = createClient(pg.urlFor({ role: DB_ROLES.capReconciler }));
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from ingest_paused`;
  await admin`delete from memberships`;
  await admin`delete from orgs`;
  await admin`delete from "user"`;
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await admin?.end();
  await reconciler?.end();
  await pg?.stop();
});

const soon = new Date("2026-08-01T00:00:00Z");

describe("flag / clear grace", () => {
  it("flags an ACTIVE org with a grace deadline, leaving it active", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon);
    const s = await orgState(org);
    expect(s.status).toBe("active"); // still active during grace
    expect(s.grace?.toISOString()).toBe(soon.toISOString());
    expect(await pauseState(org)).toBeNull(); // ingest NOT paused during grace
  });

  it("clears a grace flag", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon);
    await clearFreeCapGrace(reconciler, org);
    expect((await orgState(org)).grace).toBeNull();
  });

  it("does NOT flag an already-suspended org (grace is only for the active window)", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon);
    await flagOrgForFreeCapGrace(reconciler, org, soon); // no-op: not active
    expect((await orgState(org)).grace).toBeNull();
  });
});

describe("suspendOrgForFreeCap", () => {
  it("suspends an active org and pauses its ingest, atomically; returns true", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon);

    expect(await suspendOrgForFreeCap(reconciler, org, soon)).toBe(true);

    const s = await orgState(org);
    expect(s.status).toBe("suspended");
    expect(s.reason).toBe("free_org_cap");
    expect(s.restore?.toISOString()).toBe(soon.toISOString());
    expect(s.grace).toBeNull(); // grace consumed on suspend
    expect(await pauseState(org)).toEqual({ paused: true, reason: "free_org_cap" });
  });

  it("is idempotent — a second call on an already-suspended org returns false, no re-stamp", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon);
    const first = await orgState(org);
    expect(await suspendOrgForFreeCap(reconciler, org, new Date("2027-01-01T00:00:00Z"))).toBe(
      false,
    );
    // restore_deadline unchanged (no re-stamp).
    expect((await orgState(org)).restore?.toISOString()).toBe(first.restore?.toISOString());
  });
});

describe("restoreOrgFromFreeCap", () => {
  it("restores a free_org_cap-suspended org and un-pauses its ingest; returns true", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon);

    expect(await restoreOrgFromFreeCap(reconciler, org)).toBe(true);

    const s = await orgState(org);
    expect(s.status).toBe("active");
    expect(s.reason).toBeNull();
    expect(s.restore).toBeNull();
    expect(await pauseState(org)).toEqual({ paused: false, reason: null });
  });

  it("returns false for an org that is NOT free_org_cap-suspended (active, or suspended for another reason)", async () => {
    const org = await seedOrg();
    expect(await restoreOrgFromFreeCap(reconciler, org)).toBe(false); // active → nothing to restore
  });

  it("un-pauses ONLY a free_org_cap pause — an event-cap ('cap') pause is left for the cap producer", async () => {
    const org = await seedOrg();
    // Org is paused for its EVENT cap (reason='cap'), set by the cap producer path (simulated as webhook_app).
    await withTenant(
      app,
      org,
      (tx) => tx`
        insert into ingest_paused (org_id, paused, reason, since, updated_at)
        values (${org}, true, 'cap', now(), now())`,
    );
    // It is NOT free_org_cap-suspended, so restore is a no-op and must not touch the 'cap' pause.
    expect(await restoreOrgFromFreeCap(reconciler, org)).toBe(false);
    expect(await pauseState(org)).toEqual({ paused: true, reason: "cap" });
  });
});
