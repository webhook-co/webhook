import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { findOwnersOverFreeCap } from "../src/org-lifecycle";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The AUTHORITATIVE free-org-cap detector (PR2b slice 2): across ALL users, find every owner of more than
// `cap` FREE orgs. This is the cross-user question the per-tenant roles can't answer — confined to
// webhook_capreconciler via role-targeted `FOR SELECT TO webhook_capreconciler USING (true)` policies +
// column grants (migration 0084) on memberships / orgs / billing_subscriptions. Driven against real Postgres
// so those policies (and the fact webhook_app CANNOT ride them) run exactly as production does.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — the request-path role; MUST NOT be able to run the detector
let owner: Sql;
let admin: Sql;
let reconciler: Sql; // webhook_capreconciler — the only role granted EXECUTE

async function seedUser(id: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@acme.test`}, ${true}, now())`;
}

async function seedOrg(ownerUserId: string): Promise<string> {
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "o",
    ownerUserId,
    auditKey: await testAuditKey(),
  });
  return id;
}

/** Create an org and pin its created_at, so oldest-first ordering is deterministic (now() can tie). */
async function seedOrgAt(ownerUserId: string, createdAt: string): Promise<string> {
  const id = await seedOrg(ownerUserId);
  await admin`update orgs set created_at = ${createdAt} where id = ${id}`;
  return id;
}

async function addOwner(orgId: string, userId: string): Promise<void> {
  await seedUser(userId);
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`,
  );
}

async function makeSub(orgId: string, status: string): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${"sub_" + orgId.slice(0, 8)}, ${"price_pro"}, ${status},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;
}
const makePaid = (orgId: string) => makeSub(orgId, "active");

const CAP = 2;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
  reconciler = createClient(pg.urlFor({ role: DB_ROLES.capReconciler }));
}, setupHookTimeoutMs());

afterEach(async () => {
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

describe("findOwnersOverFreeCap (role-targeted cross-user detection)", () => {
  it("returns an owner over the cap with ALL their free orgs, oldest-first", async () => {
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrgAt(u, "2026-01-01T00:00:00Z");
    const b = await seedOrgAt(u, "2026-02-01T00:00:00Z");
    const c = await seedOrgAt(u, "2026-03-01T00:00:00Z");

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    expect(over).toHaveLength(1);
    expect(over[0]!.userId).toBe(u);
    expect(over[0]!.freeOrgs.map((o) => o.orgId)).toEqual([a, b, c]); // oldest → newest
    expect(over[0]!.freeOrgs.every((o) => o.status === "active")).toBe(true);
  });

  it("does NOT return a user AT the cap", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u); // exactly CAP=2 free orgs
    expect(await findOwnersOverFreeCap(reconciler, CAP)).toEqual([]);
  });

  it("excludes PAID orgs from both the count and the returned list", async () => {
    // 2 free + 2 paid: only 2 free ⇒ NOT over the cap.
    const under = randomUUID();
    await seedUser(under);
    await seedOrg(under);
    await seedOrg(under);
    await makePaid(await seedOrg(under));
    await makePaid(await seedOrg(under));
    expect(await findOwnersOverFreeCap(reconciler, CAP)).toEqual([]);

    // 3 free + 1 paid: over the cap; the paid org must NOT appear in the returned free list.
    const over = randomUUID();
    await seedUser(over);
    const f1 = await seedOrg(over);
    const f2 = await seedOrg(over);
    const f3 = await seedOrg(over);
    const paid = await seedOrg(over);
    await makePaid(paid);

    const res = await findOwnersOverFreeCap(reconciler, CAP);
    const row = res.find((r) => r.userId === over)!;
    expect(row.freeOrgs.map((o) => o.orgId).sort()).toEqual([f1, f2, f3].sort());
    expect(row.freeOrgs.some((o) => o.orgId === paid)).toBe(false);
  });

  it("counts a CO-OWNED free org toward EACH owner (both can be over the cap)", async () => {
    // Alice: 2 solo + 1 shared = 3 free → over. Bob: only the shared = 1 free → under.
    const alice = randomUUID();
    const bob = randomUUID();
    await seedUser(alice);
    await seedOrg(alice);
    await seedOrg(alice);
    const shared = await seedOrg(alice);
    await addOwner(shared, bob); // co-owned

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    expect(over.map((o) => o.userId)).toEqual([alice]);
    expect(over[0]!.freeOrgs.some((o) => o.orgId === shared)).toBe(true);
  });

  it("returns a suspended org with its status/reason, so the reconciler can skip re-suspending it", async () => {
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u);
    const third = await seedOrg(u);
    await withTenant(
      app,
      third,
      (tx) => tx`
        update orgs set status = 'suspended', suspended_reason = 'free_org_cap', suspended_at = now()
        where id = ${third}`,
    );

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    const seen = over[0]!.freeOrgs.find((o) => o.orgId === third)!;
    expect(seen).toMatchObject({ status: "suspended", suspendedReason: "free_org_cap" });
  });

  it("groups MULTIPLE over-cap owners in one call, each with only their own free orgs", async () => {
    // Proves the per-owner grouping: two distinct over-cap users must come back as two rows, and neither's
    // orgs bleed into the other's.
    const a = randomUUID();
    const b = randomUUID();
    await seedUser(a);
    await seedUser(b);
    const aOrgs = [await seedOrg(a), await seedOrg(a), await seedOrg(a)];
    const bOrgs = [await seedOrg(b), await seedOrg(b), await seedOrg(b)];

    const over = await findOwnersOverFreeCap(reconciler, CAP);
    expect(over.map((o) => o.userId).sort()).toEqual([a, b].sort());
    const seenA = over.find((o) => o.userId === a)!;
    const seenB = over.find((o) => o.userId === b)!;
    expect(seenA.freeOrgs.map((o) => o.orgId).sort()).toEqual([...aOrgs].sort());
    expect(seenB.freeOrgs.map((o) => o.orgId).sort()).toEqual([...bOrgs].sort());
  });

  it("uses the full entitlement matrix: trialing/past_due are PAID; canceled/unpaid/unknown are Free", async () => {
    // Parity with hasEntitledSubscription/BILLING_ACTIVE_STATUSES: only active/trialing/past_due are entitled
    // (paid, excluded); every OTHER status counts the org as Free. A user with 2 entitled + 3 non-entitled has
    // 3 free orgs → over CAP=2, and the returned list is exactly those 3 (the entitled ones never appear).
    const u = randomUUID();
    await seedUser(u);
    const trialing = await seedOrg(u);
    await makeSub(trialing, "trialing"); // entitled → PAID → excluded
    const pastDue = await seedOrg(u);
    await makeSub(pastDue, "past_due"); // entitled → PAID → excluded
    const canceled = await seedOrg(u);
    await makeSub(canceled, "canceled"); // not entitled → FREE
    const unpaid = await seedOrg(u);
    await makeSub(unpaid, "unpaid"); // not entitled → FREE
    const unknown = await seedOrg(u);
    await makeSub(unknown, "incomplete_expired"); // not entitled → FREE

    const res = await findOwnersOverFreeCap(reconciler, CAP);
    const row = res.find((r) => r.userId === u)!;
    expect(row.freeOrgs.map((o) => o.orgId).sort()).toEqual([canceled, unpaid, unknown].sort());
    expect(row.freeOrgs.some((o) => o.orgId === trialing || o.orgId === pastDue)).toBe(false);
  });

  it("does not return a user who owns ONLY paid orgs, however many", async () => {
    const u = randomUUID();
    await seedUser(u);
    await makePaid(await seedOrg(u));
    await makePaid(await seedOrg(u));
    await makePaid(await seedOrg(u)); // 3 orgs, all paid → 0 free → never over the cap
    expect(await findOwnersOverFreeCap(reconciler, CAP)).toEqual([]);
  });

  it("reveals NOTHING to webhook_app — the cross-user reach is confined to the reconciler role by RLS", async () => {
    // The confinement: the cross-org read rides role-targeted `..._capreconciler_select` policies that ONLY
    // webhook_capreconciler has. webhook_app can run the same query (it has table SELECT), but its RLS is
    // `org_id = current_org_id()` and there's no tenant GUC here, so it sees NO rows. A compromised web
    // request therefore can't turn this into a cross-user enumeration oracle — same over-cap owner, empty
    // result for webhook_app, full result for the reconciler.
    const u = randomUUID();
    await seedUser(u);
    await seedOrg(u);
    await seedOrg(u);
    await seedOrg(u); // 3 free → over the cap

    expect(await findOwnersOverFreeCap(app, CAP)).toEqual([]); // request-path role: nothing
    expect((await findOwnersOverFreeCap(reconciler, CAP)).map((o) => o.userId)).toEqual([u]); // reconciler: sees it
  });
});

describe("findOwnersOverFreeCap — the keep mark (slice 5)", () => {
  /** Mark an org to be kept BY a given user, exactly as the picker's per-org tenant write does. */
  const mark = (orgId: string, byUserId: string) =>
    withTenant(
      app,
      orgId,
      (tx) => tx`
        update orgs
           set free_org_cap_keep_requested_at = now(), free_org_cap_keep_requested_by = ${byUserId}
         where id = ${orgId}`,
    );

  const freeOrgIds = async (userId: string) =>
    (await findOwnersOverFreeCap(reconciler, CAP))
      .find((o) => o.userId === userId)!
      .freeOrgs.map((o) => o.orgId);

  it("with NOTHING marked, the order is unchanged — oldest first (today's default)", async () => {
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrg(u);
    const b = await seedOrg(u);
    const c = await seedOrg(u);
    await admin`update orgs set created_at = '2026-01-01' where id = ${a}`;
    await admin`update orgs set created_at = '2026-02-01' where id = ${b}`;
    await admin`update orgs set created_at = '2026-03-01' where id = ${c}`;

    expect(await freeOrgIds(u)).toEqual([a, b, c]); // → slice(2) suspends c, the newest
  });

  it("a marked org sorts to the FRONT, so the caller's slice(cap) spares it", async () => {
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrg(u);
    const b = await seedOrg(u);
    const c = await seedOrg(u);
    await admin`update orgs set created_at = '2026-01-01' where id = ${a}`;
    await admin`update orgs set created_at = '2026-02-01' where id = ${b}`;
    await admin`update orgs set created_at = '2026-03-01' where id = ${c}`;

    await mark(c, u); // the newest — the one the default would have suspended
    // c now leads; slice(2) keeps [c, a] and suspends b instead. That IS the feature.
    expect(await freeOrgIds(u)).toEqual([c, a, b]);
  });

  it("marking EVERY org is identical to marking none — the mark cannot escape the cap", async () => {
    // The load-bearing property. The web app writes marks one org per transaction, so "at most cap marked"
    // is unenforceable at write time; the reconciler re-validates by slicing at cap regardless. A user who
    // marks everything reorders nothing and still loses their newest org.
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrg(u);
    const b = await seedOrg(u);
    const c = await seedOrg(u);
    await admin`update orgs set created_at = '2026-01-01' where id = ${a}`;
    await admin`update orgs set created_at = '2026-02-01' where id = ${b}`;
    await admin`update orgs set created_at = '2026-03-01' where id = ${c}`;

    await mark(a, u);
    await mark(b, u);
    await mark(c, u);
    expect(await freeOrgIds(u)).toEqual([a, b, c]); // all marked → tie → oldest-first, exactly as unmarked
  });

  it("ties among marked orgs fall back to oldest-first, not to mark time", async () => {
    // Marked-ness is a boolean sort key; the timestamp is for display/audit. Sorting by mark time would
    // invent a second policy ("last click wins") that nothing else in the lane follows.
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrg(u);
    const b = await seedOrg(u);
    const c = await seedOrg(u);
    await admin`update orgs set created_at = '2026-01-01' where id = ${a}`;
    await admin`update orgs set created_at = '2026-02-01' where id = ${b}`;
    await admin`update orgs set created_at = '2026-03-01' where id = ${c}`;

    // b is marked FIRST, c SECOND — so "most recently marked" would put c ahead, while "oldest created"
    // puts b ahead. The two rules disagree here, which is the only reason this test is worth writing.
    await mark(b, u);
    await mark(c, u);
    // b leads: created_at wins, mark time is not a sort key. Unmarked a trails both.
    expect(await freeOrgIds(u)).toEqual([b, c, a]);
  });

  it("a CO-OWNER's mark cannot re-rank YOUR list — one owner's intent never speaks for another's slots", async () => {
    // THE security property of this slice, and a real hole before attribution existed.
    //
    // The mark is a column on the ORG (ADR-0113 forbids the per-(user, org) table this would otherwise want),
    // so every co-owner can set it and every co-owner sees it. But the CAP is counted PER OWNER. Without
    // `keep_requested_by`, X marking a shared org re-ranked V's whole list — pushing an org of V's that X is
    // not a member of, cannot read, and cannot name, into V's overflow to be suspended. X's own list stayed
    // untouched. Owning the marked org was true; the blast radius landed on a different tenant entirely.
    const victim = randomUUID();
    const attacker = randomUUID();
    await seedUser(victim);

    const a = await seedOrgAt(victim, "2026-01-01T00:00:00Z"); // V's, private
    const b = await seedOrgAt(victim, "2026-02-01T00:00:00Z"); // V's, private — the target
    const shared = await seedOrgAt(victim, "2026-03-01T00:00:00Z"); // V's throwaway, co-owned with X
    await addOwner(shared, attacker); // owner→owner invites are supported

    // Baseline: V is over cap by one, so the newest (the shared throwaway) is the overflow. V is fine with it.
    expect(await freeOrgIds(victim)).toEqual([a, b, shared]);

    // X marks the org they legitimately co-own.
    await mark(shared, attacker);

    // V's ranking is UNCHANGED: X's mark counts only in X's own list. `b` is not pushed into the overflow.
    expect(await freeOrgIds(victim)).toEqual([a, b, shared]);
  });

  it("both owners' marks coexist — each steers only its author's ranking", async () => {
    const v = randomUUID();
    const x = randomUUID();
    await seedUser(v);
    const a = await seedOrgAt(v, "2026-01-01T00:00:00Z");
    const b = await seedOrgAt(v, "2026-02-01T00:00:00Z");
    const shared = await seedOrgAt(v, "2026-03-01T00:00:00Z");
    await addOwner(shared, x);
    // Give X enough free orgs of their own to be over cap too, so both appear in the result.
    await seedOrgAt(x, "2026-04-01T00:00:00Z");
    await seedOrgAt(x, "2026-05-01T00:00:00Z");

    await mark(shared, x); // X wants the shared one kept…
    await mark(b, v); // …V wants their own `b` kept.

    // V's list: b floats (V marked it); shared does NOT (X's mark is not V's).
    expect(await freeOrgIds(v)).toEqual([b, a, shared]);
    // X's list: shared floats (X marked it).
    expect((await freeOrgIds(x))[0]).toBe(shared);
  });

  it("surfaces keepRequestedAt so the reconciler's callers can see the choice", async () => {
    const u = randomUUID();
    await seedUser(u);
    const a = await seedOrg(u);
    await seedOrg(u);
    await seedOrg(u);
    await mark(a, u);

    const marked = (await findOwnersOverFreeCap(reconciler, CAP))
      .find((o) => o.userId === u)!
      .freeOrgs.filter((o) => o.keepRequestedAt !== null);
    expect(marked.map((o) => o.orgId)).toEqual([a]);
    expect(marked[0]!.keepRequestedAt).toBeInstanceOf(Date);
  });
});
