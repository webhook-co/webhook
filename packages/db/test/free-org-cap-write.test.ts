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

/** Every notification intent queued for the org, oldest first (admin bypasses RLS). */
async function intentsFor(orgId: string) {
  return admin<{ kind: string; status: string; context: Record<string, unknown> | null }[]>`
    select kind, status, context from notification_intents
     where org_id = ${orgId} order by created_at, kind`;
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
/** The free-org cap the reconciler was told to enforce — snapshotted into each notification's context. */
const CAP = 2;

describe("flag / clear grace", () => {
  it("flags an ACTIVE org with a grace deadline, leaving it active", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);
    const s = await orgState(org);
    expect(s.status).toBe("active"); // still active during grace
    expect(s.grace?.toISOString()).toBe(soon.toISOString());
    expect(await pauseState(org)).toBeNull(); // ingest NOT paused during grace
  });

  it("clears a grace flag", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);
    await clearFreeCapGrace(reconciler, org);
    expect((await orgState(org)).grace).toBeNull();
  });

  it("is idempotent on the deadline — re-flagging keeps the FIRST deadline (the cron re-flags every pass)", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);
    const later = new Date("2027-01-01T00:00:00Z");
    await flagOrgForFreeCapGrace(reconciler, org, later, CAP); // second flag must NOT move the deadline
    expect((await orgState(org)).grace?.toISOString()).toBe(soon.toISOString());
  });

  it("does NOT flag an already-suspended org (grace is only for the active window)", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP); // no-op: not active
    expect((await orgState(org)).grace).toBeNull();
  });
});

describe("free-cap notifications (slice 4) — nothing happens to an org un-announced", () => {
  it("a flag enqueues a pending WARNING intent carrying the deadline + cap", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);
    const intents = await intentsFor(org);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "free_org_cap_warning", status: "pending" });
    expect(intents[0]!.context).toEqual({ graceUntilIso: soon.toISOString(), cap: CAP });
  });

  it("a suspend enqueues a pending SUSPENDED intent carrying the restore deadline + cap", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    const intents = await intentsFor(org);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "free_org_cap_suspended", status: "pending" });
    expect(intents[0]!.context).toEqual({ restoreDeadlineIso: soon.toISOString(), cap: CAP });
  });

  it("a re-flag does NOT re-warn — the cron re-flags every pass for the whole grace window", async () => {
    const org = await seedOrg();
    expect(await flagOrgForFreeCapGrace(reconciler, org, soon, CAP)).toBe(true);
    expect(await flagOrgForFreeCapGrace(reconciler, org, soon, CAP)).toBe(false);
    expect(await flagOrgForFreeCapGrace(reconciler, org, soon, CAP)).toBe(false);
    expect(await intentsFor(org)).toHaveLength(1); // one warning, not three
  });

  it("a re-suspend does NOT re-notify", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    const kinds = (await intentsFor(org)).map((i) => i.kind);
    expect(kinds).toEqual(["free_org_cap_suspended"]);
  });

  it("a flag that no-ops (org not active) enqueues NOTHING", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP); // no-op: not active
    const kinds = (await intentsFor(org)).map((i) => i.kind);
    expect(kinds).toEqual(["free_org_cap_suspended"]); // no stray warning
  });

  it("the full lifecycle warns ONCE then suspends ONCE, in order", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    expect((await intentsFor(org)).map((i) => i.kind)).toEqual([
      "free_org_cap_warning",
      "free_org_cap_suspended",
    ]);
  });

  it("the intent is written in the SAME tx as the suspend — a failed enqueue rolls the suspend back", async () => {
    // Atomicity is the whole point: a suspend that commits without its notification is the exact failure
    // this slice exists to prevent. Force the enqueue to fail by removing the table's insert path for the
    // role, and assert the org is still active afterwards.
    const org = await seedOrg();
    await admin`revoke insert on notification_intents from ${admin(DB_ROLES.capReconciler)}`;
    try {
      await expect(suspendOrgForFreeCap(reconciler, org, soon, CAP)).rejects.toThrow();
      expect((await orgState(org)).status).toBe("active"); // rolled back — not silently suspended
      expect(await pauseState(org)).toBeNull();
    } finally {
      await admin`grant insert (id, org_id, kind, destination_id, context)
                  on notification_intents to ${admin(DB_ROLES.capReconciler)}`;
    }
  });

  it("the reconciler cannot mint a pre-'sent' intent (no status grant) — it can't silence itself", async () => {
    // status is ungranted, so the only value the role can produce is the column default.
    await expect(
      reconciler`
        insert into notification_intents (id, org_id, kind, destination_id, status)
        values (${randomUUID()}, ${randomUUID()}, 'free_org_cap_suspended', null, 'sent')`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("suspendOrgForFreeCap", () => {
  it("suspends an active org and pauses its ingest, atomically; returns true", async () => {
    const org = await seedOrg();
    await flagOrgForFreeCapGrace(reconciler, org, soon, CAP);

    expect(await suspendOrgForFreeCap(reconciler, org, soon, CAP)).toBe(true);

    const s = await orgState(org);
    expect(s.status).toBe("suspended");
    expect(s.reason).toBe("free_org_cap");
    expect(s.restore?.toISOString()).toBe(soon.toISOString());
    expect(s.grace).toBeNull(); // grace consumed on suspend
    expect(await pauseState(org)).toEqual({ paused: true, reason: "free_org_cap" });
  });

  it("is idempotent — a second call on an already-suspended org returns false, no re-stamp", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    const first = await orgState(org);
    expect(await suspendOrgForFreeCap(reconciler, org, new Date("2027-01-01T00:00:00Z"), CAP)).toBe(
      false,
    );
    // restore_deadline unchanged (no re-stamp).
    expect((await orgState(org)).restore?.toISOString()).toBe(first.restore?.toISOString());
  });
});

describe("restoreOrgFromFreeCap", () => {
  it("restores a free_org_cap-suspended org and un-pauses its ingest; returns true", async () => {
    const org = await seedOrg();
    await suspendOrgForFreeCap(reconciler, org, soon, CAP);

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

  it("BOTH caps: suspend overwrites a 'cap' pause → free_org_cap; restore then un-pauses (cap producer re-pauses)", async () => {
    // Documents the self-healing composition (reviewed, accepted): an org already event-cap-paused is then
    // free-org-cap-suspended — the pause reason becomes 'free_org_cap' (required for the non-clobber). On
    // restore the ingest un-pauses even though it may still be over its event cap; the NEXT cap-producer pass
    // re-pauses it (reason='cap'). Bounded, Free-tier only, no revenue path.
    const org = await seedOrg();
    await withTenant(
      app,
      org,
      (tx) => tx`
        insert into ingest_paused (org_id, paused, reason, since, updated_at)
        values (${org}, true, 'cap', now(), now())`,
    );

    await suspendOrgForFreeCap(reconciler, org, soon, CAP);
    // The suspend overwrote the 'cap' reason (necessary so the cap producer won't resume a suspended org).
    expect(await pauseState(org)).toEqual({ paused: true, reason: "free_org_cap" });

    await restoreOrgFromFreeCap(reconciler, org);
    // Un-paused here; if still over the event cap, the cap producer re-pauses within one interval.
    expect(await pauseState(org)).toEqual({ paused: false, reason: null });
    expect((await orgState(org)).status).toBe("active");
  });
});
