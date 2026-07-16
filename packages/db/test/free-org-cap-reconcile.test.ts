import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { isTotalFreeOrgCapFailure, runFreeOrgCapReconcile } from "../src/free-org-cap-reconcile";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The authoritative free-org-cap reconcile pass (PR2b slice 3b): flag → suspend at the grace deadline →
// restore when the owner resolves the overage. Driven end-to-end against real Postgres as the reconciler role.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let admin: Sql;
let reconciler: Sql;

const CAP = 2;
const GRACE_MS = 14 * 24 * 3600_000;
const REMINDER_MS = 7 * 24 * 3600_000;
const MIN_LEAD_MS = 24 * 3600_000;
const DAY = 24 * 3600_000;
const T0 = Date.parse("2026-07-01T00:00:00Z");

async function seedUser(): Promise<string> {
  const uid = randomUUID();
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${uid}, ${uid}, ${`${uid}@t.test`}, ${true}, now())`;
  return uid;
}

/** Create a free org for `uid` with a pinned created_at (so oldest-first overflow selection is deterministic). */
async function seedOrgAt(uid: string, createdAt: string): Promise<string> {
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "o",
    ownerUserId: uid,
    auditKey: await testAuditKey(),
  });
  await admin`update orgs set created_at = ${createdAt} where id = ${id}`;
  return id;
}

async function orgState(orgId: string) {
  const [r] = await admin<
    { status: string; reason: string | null; grace: Date | null }[]
  >`select status, suspended_reason as reason, free_org_cap_grace_until as grace from orgs where id = ${orgId}`;
  return r!;
}

/** Per-org failures logged by the pass under test — asserted, not discarded (an `errors` count with no id or
 *  reason is useless to an operator, which is the whole point of the `log` dep). */
let logged: Array<{ message: string; fields: Record<string, unknown> }> = [];

const reconcile = (now: number) =>
  runFreeOrgCapReconcile(reconciler, {
    now,
    cap: CAP,
    graceMs: GRACE_MS,
    reminderMs: REMINDER_MS,
    minReminderLeadMs: MIN_LEAD_MS,
    log: (message, fields) => logged.push({ message, fields }),
  });

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
  await admin`delete from billing_subscriptions`;
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

describe("runFreeOrgCapReconcile", () => {
  it("flags the overflow (newest beyond the oldest cap), leaving all orgs active", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z"); // A (kept)
    await seedOrgAt(uid, "2026-02-01T00:00:00Z"); // B (kept)
    const c = await seedOrgAt(uid, "2026-03-01T00:00:00Z"); // C (overflow)

    const res = await reconcile(T0);
    expect(res).toMatchObject({ flagged: 1, suspended: 0, restored: 0 });
    const s = await orgState(c);
    expect(s.status).toBe("active"); // still active during grace
    expect(s.grace).not.toBeNull();
  });

  it("does not suspend while still within the grace window, then suspends once past it", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid, "2026-02-01T00:00:00Z");
    const c = await seedOrgAt(uid, "2026-03-01T00:00:00Z");

    await reconcile(T0); // flags C
    const mid = await reconcile(T0 + GRACE_MS - 1000); // still in grace
    expect(mid.suspended).toBe(0);
    expect((await orgState(c)).status).toBe("active");

    const late = await reconcile(T0 + GRACE_MS + 1000); // past the deadline
    expect(late.suspended).toBe(1);
    const s = await orgState(c);
    expect(s.status).toBe("suspended");
    expect(s.reason).toBe("free_org_cap");
  });

  it("sends the T-7 reminder once inside the reminder window, then suspends at the deadline", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid, "2026-02-01T00:00:00Z");
    const c = await seedOrgAt(uid, "2026-03-01T00:00:00Z");

    expect(await reconcile(T0)).toMatchObject({ flagged: 1, reminded: 0 });
    // Early in grace: nothing owed.
    expect(await reconcile(T0 + DAY)).toMatchObject({ flagged: 0, reminded: 0, suspended: 0 });
    // Inside the reminder window: exactly one reminder…
    expect(await reconcile(T0 + GRACE_MS - REMINDER_MS)).toMatchObject({ reminded: 1 });
    // …and the cron re-asking every hour after that must not re-send it.
    expect(await reconcile(T0 + GRACE_MS - REMINDER_MS + DAY)).toMatchObject({ reminded: 0 });
    expect((await orgState(c)).status).toBe("active"); // a reminder never suspends

    expect(await reconcile(T0 + GRACE_MS + 1000)).toMatchObject({ suspended: 1 });
  });

  it("suspends rather than reminds an org whose deadline passed while the reminder never went out", async () => {
    // The cron can be delayed, or the reminder can throw for a whole window. Nudging someone about a deadline
    // that is already behind them ("you have until <past date>") is worse than useless.
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid, "2026-02-01T00:00:00Z");
    await seedOrgAt(uid, "2026-03-01T00:00:00Z");
    await reconcile(T0); // flags, never reminds
    const late = await reconcile(T0 + GRACE_MS + DAY); // first pass after a long gap
    expect(late).toMatchObject({ reminded: 0, suspended: 1 });
  });

  it("restores a suspended org once the owner is no longer over the cap (resolved the overage)", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z"); // A
    const b = await seedOrgAt(uid, "2026-02-01T00:00:00Z"); // B
    const c = await seedOrgAt(uid, "2026-03-01T00:00:00Z"); // C (overflow → suspended)

    await reconcile(T0);
    await reconcile(T0 + GRACE_MS + 1000); // C suspended
    expect((await orgState(c)).status).toBe("suspended");

    // Owner resolves by UPGRADING B to a paid plan → now only A + C are free = 2 = at cap (not over).
    await admin`
      insert into billing_subscriptions
        (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
      values (${b}, ${"sub_" + b.slice(0, 8)}, ${"price_pro"}, ${"active"},
              ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;

    const res = await reconcile(T0 + GRACE_MS + 2000);
    expect(res.restored).toBe(1);
    expect((await orgState(c)).status).toBe("active");
  });

  it("clears the grace flag if the owner resolves the overage DURING the grace window (no suspend)", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z"); // A
    const b = await seedOrgAt(uid, "2026-02-01T00:00:00Z"); // B
    const c = await seedOrgAt(uid, "2026-03-01T00:00:00Z"); // C (flagged)

    await reconcile(T0); // flags C
    expect((await orgState(c)).grace).not.toBeNull();

    await admin`
      insert into billing_subscriptions
        (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
      values (${b}, ${"sub_" + b.slice(0, 8)}, ${"price_pro"}, ${"active"},
              ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;

    const res = await reconcile(T0 + 1000); // still within grace, but owner now at cap
    expect(res.graceCleared).toBe(1);
    expect(res.suspended).toBe(0);
    const s = await orgState(c);
    expect(s.status).toBe("active");
    expect(s.grace).toBeNull();
  });

  it("does nothing for an owner AT the cap; a re-run past the deadline is idempotent", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid, "2026-02-01T00:00:00Z"); // exactly CAP free orgs
    expect(await reconcile(T0)).toMatchObject({ flagged: 0, suspended: 0, restored: 0 });

    // And a 4-org owner: flag+suspend the two overflow, then a re-run does nothing new.
    const uid2 = await seedUser();
    await seedOrgAt(uid2, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid2, "2026-02-01T00:00:00Z");
    await seedOrgAt(uid2, "2026-03-01T00:00:00Z");
    await seedOrgAt(uid2, "2026-04-01T00:00:00Z");
    await reconcile(T0); // flags the 2 overflow
    const suspendPass = await reconcile(T0 + GRACE_MS + 1000);
    expect(suspendPass.suspended).toBe(2);
    const rerun = await reconcile(T0 + GRACE_MS + 2000);
    expect(rerun).toMatchObject({ flagged: 0, suspended: 0, restored: 0, graceCleared: 0 });
  });

  it("a failing enforce step does NOT strand already-suspended orgs — the undo loop still runs", async () => {
    // The enforce step now INSERTs a notification intent in-tx, so it depends on a grant on a SECOND table.
    // Without per-org isolation a throw there escapes runFreeOrgCapReconcile entirely and the restore loop
    // never executes — so an owner who already resolved their overage would stay suspended forever, every
    // pass, silently. That is the worst direction for this cron to fail in, hence this test.
    const victim = await seedUser();
    await seedOrgAt(victim, "2026-01-01T00:00:00Z");
    await seedOrgAt(victim, "2026-02-01T00:00:00Z");
    const overflowOrg = await seedOrgAt(victim, "2026-03-01T00:00:00Z");
    await reconcile(T0);
    await reconcile(T0 + GRACE_MS + 1000);
    expect((await orgState(overflowOrg)).status).toBe("suspended");

    // The owner resolves the overage (delete an org they no longer need) → the overflow org is now restorable.
    const [{ id: dropped }] = await admin<{ id: string }[]>`
      select id from orgs where id != ${overflowOrg}
        and id in (select org_id from memberships where user_id = ${victim}) limit 1`;
    await admin`delete from orgs where id = ${dropped}`;

    // Meanwhile a DIFFERENT owner is over cap, and enforcing them will throw (intent INSERT revoked).
    const other = await seedUser();
    await seedOrgAt(other, "2026-01-01T00:00:00Z");
    await seedOrgAt(other, "2026-02-01T00:00:00Z");
    await seedOrgAt(other, "2026-03-01T00:00:00Z");
    await owner`revoke insert on notification_intents from ${owner(DB_ROLES.capReconciler)}`;
    try {
      logged = [];
      const pass = await reconcile(T0 + GRACE_MS + 2000);
      expect(pass.errors).toBeGreaterThan(0); // the other owner's flag threw and was counted
      expect(pass.restored).toBe(1); // ...and the restore STILL happened
      expect((await orgState(overflowOrg)).status).toBe("active");

      // The failure is DIAGNOSABLE: swallowing it into a bare counter would leave an operator with
      // `errors: 1` and no org id and no reason.
      const fail = logged.find((l) => l.message === "free_org_cap.enforce_failed");
      expect(fail).toBeDefined();
      expect(fail!.fields.orgId).toEqual(expect.any(String));
      expect(String(fail!.fields.error)).toMatch(/permission denied/i);

      // The ENFORCE loop is totally broken here (every flag threw), so this MUST escalate even though the
      // undo loop succeeded. An earlier version pooled both loops into one attempted/errors ratio and scored
      // this "partial" — meaning a rolled-back 0086 grant would leave the cap 100% unenforced every hour, and
      // any single successful restore would hide it. The loops are judged independently.
      expect(pass.phases.flag).toEqual({ attempted: 1, errors: 1 });
      expect(pass.phases.undo).toEqual({ attempted: 1, errors: 0 });
      expect(isTotalFreeOrgCapFailure(pass)).toBe(true);
    } finally {
      await owner`grant insert (id, org_id, kind, destination_id, context)
                  on notification_intents to ${owner(DB_ROLES.capReconciler)}`;
    }
  });

  it("a TOTAL failure is escalatable — otherwise an unenforced cap looks like a healthy no-op pass", async () => {
    // Per-org isolation alone converts a DETERMINISTIC failure (regressed grant, rolled-back migration) into
    // an INFO line shaped exactly like a clean pass, while the cap goes 100% unenforced every hour forever.
    // isTotalFreeOrgCapFailure is what the engine cron throws on so alerting fires.
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z");
    await seedOrgAt(uid, "2026-02-01T00:00:00Z");
    await seedOrgAt(uid, "2026-03-01T00:00:00Z");
    await owner`revoke insert on notification_intents from ${owner(DB_ROLES.capReconciler)}`;
    try {
      const pass = await reconcile(T0);
      expect(pass).toMatchObject({ flagged: 0, attempted: 1, errors: 1 });
      expect(isTotalFreeOrgCapFailure(pass)).toBe(true);
      // A partial failure WITHIN a phase still must not escalate — only an all-failed phase does.
      expect(
        isTotalFreeOrgCapFailure({
          ...pass,
          phases: {
            flag: { attempted: 2, errors: 1 },
            remind: { attempted: 0, errors: 0 },
            suspend: { attempted: 0, errors: 0 },
            undo: { attempted: 0, errors: 0 },
          },
        }),
      ).toBe(false);
    } finally {
      await owner`grant insert (id, org_id, kind, destination_id, context)
                  on notification_intents to ${owner(DB_ROLES.capReconciler)}`;
    }
  });

  it("an all-quiet pass is NOT a total failure (nothing attempted ≠ everything failed)", async () => {
    const uid = await seedUser();
    await seedOrgAt(uid, "2026-01-01T00:00:00Z"); // under the cap → nothing to do
    const pass = await reconcile(T0);
    expect(pass).toMatchObject({ attempted: 0, errors: 0 });
    expect(pass.phases.flag).toEqual({ attempted: 0, errors: 0 });
    expect(pass.phases.undo).toEqual({ attempted: 0, errors: 0 });
    expect(isTotalFreeOrgCapFailure(pass)).toBe(false); // must not alert on a healthy quiet hour
  });
});
