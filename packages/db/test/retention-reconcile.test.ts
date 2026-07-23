import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  isMoreRestrictiveWindow,
  reconcileRetentionFromStripe,
  type StripeSubscriptionLister,
} from "../src/retention-reconcile";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// S2b retention reconciler. The catastrophe this guards: a paying customer's retention window stuck too
// LOW (e.g. the Free 7) while their plan entitles more → the hourly prune deletes their events + R2 bodies
// on day 8. S2a made the unparseable-subscription bug repairable + logged; this closes the loop by
// AUTO-REPAIRING drift and alarming on what it won't touch.
//
// Stripe is the source of truth (it holds the plan → retention mapping in price metadata), and the
// reconciler enumerates active subscriptions FROM Stripe — so it also catches an org whose subscription
// never mirrored at all (no billing_subscriptions row), which a DB-only reconcile could never see.
//
// The ONE safety rule: repair only in the LENGTHENING direction. Shrinking a window DELETES data — the very
// harm we're preventing — so a bug in the reconciler must never be able to cause it. An org with MORE
// retention than its plan entitles (over-retention, the safe miss) is ALARMED, never auto-shrunk.

let pg: EphemeralPostgres;
let app: Sql; // seeds orgs
let billing: Sql; // webhook_billing — the reconciler's per-org read+repair role
let admin: Sql;

/** A raw Stripe subscription object, shaped exactly as parseSubscriptionObject expects. */
function stripeSub(
  orgId: string,
  opts: { status?: string; retentionDays?: number | "unlimited" | "absent"; subId?: string } = {},
): Record<string, unknown> {
  const { status = "active", retentionDays = 30, subId = "sub_" + orgId.slice(0, 8) } = opts;
  const priceMeta: Record<string, string> =
    retentionDays === "absent"
      ? {}
      : { retention_days: retentionDays === "unlimited" ? "unlimited" : String(retentionDays) };
  return {
    id: subId,
    customer: "cus_" + orgId.slice(0, 8),
    status,
    metadata: { org_id: orgId },
    current_period_start: Math.floor(Date.UTC(2026, 6, 1) / 1000),
    current_period_end: Math.floor(Date.UTC(2026, 7, 1) / 1000),
    items: { data: [{ price: { id: "price_pro", metadata: priceMeta } }] },
  };
}

function listerOf(...subs: Record<string, unknown>[]): StripeSubscriptionLister {
  return { listSubscriptions: async () => subs };
}

/** Seed an org with a given retention window (webhook_app, under RLS). */
async function seedOrg(retentionDays: number | null): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, retention_days)
             values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"}, ${retentionDays})`;
  });
  return orgId;
}

async function windowOf(orgId: string): Promise<number | null> {
  const [row] = await admin<{ retention_days: number | null }[]>`
    select retention_days from orgs where id = ${orgId}`;
  return row?.retention_days ?? null;
}

function reconcile(reader: StripeSubscriptionLister, log?: (m: string, f?: unknown) => void) {
  return reconcileRetentionFromStripe({ billing, reader, limit: 100, log: log as never });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  billing = createClient(pg.urlFor({ role: DB_ROLES.billing }));
  admin = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await Promise.all([app?.end(), billing?.end(), admin?.end()]);
  await pg?.stop();
});

afterEach(async () => {
  await admin`delete from orgs`;
});

describe("isMoreRestrictiveWindow (pure) — NULL is unlimited = least restrictive", () => {
  it("orders windows by how much data they would delete", () => {
    // Smaller finite window = more restrictive. NULL (unlimited) is the least restrictive of all.
    expect(isMoreRestrictiveWindow(7, 30)).toBe(true); // 7 deletes more than 30
    expect(isMoreRestrictiveWindow(30, 7)).toBe(false);
    expect(isMoreRestrictiveWindow(30, 30)).toBe(false); // equal
    expect(isMoreRestrictiveWindow(30, null)).toBe(true); // finite is more restrictive than unlimited
    expect(isMoreRestrictiveWindow(null, 30)).toBe(false); // unlimited never deletes → never more restrictive
    expect(isMoreRestrictiveWindow(null, null)).toBe(false);
  });
});

describe("reconcileRetentionFromStripe — the safe auto-repair", () => {
  it("REPAIRS a paid org stuck on the Free window UP to what its plan entitles", async () => {
    const org = await seedOrg(7); // stuck at Free — the exact S2 bug symptom
    const result = await reconcile(listerOf(stripeSub(org, { retentionDays: 30 })));

    expect(await windowOf(org)).toBe(30); // lengthened to the entitled window
    expect(result.repaired).toEqual([{ orgId: org, from: 7, to: 30 }]);
    expect(result.overRetained).toEqual([]);
  });

  it("REPAIRS an org that NEVER MIRRORED (no billing_subscriptions row) — Stripe is authoritative", async () => {
    // The exact residual of the unparseable-then-rejected bug (S2a): the subscription event never landed a
    // billing_subscriptions row, so a DB-only reconcile is blind to it. This reconciler enumerates from
    // Stripe, so it still sees the entitlement and repairs. Prove there is genuinely NO mirror row backing
    // the repair — otherwise this test would be indistinguishable from the plain repair case above.
    const org = await seedOrg(7);
    const [before] = await admin<{ n: number }[]>`
      select count(*)::int as n from billing_subscriptions where org_id = ${org}`;
    expect(before!.n).toBe(0); // genuinely un-mirrored

    const result = await reconcile(listerOf(stripeSub(org, { retentionDays: 90 })));

    expect(await windowOf(org)).toBe(90); // repaired from Stripe alone
    expect(result.repaired).toHaveLength(1);
    const [after] = await admin<{ n: number }[]>`
      select count(*)::int as n from billing_subscriptions where org_id = ${org}`;
    expect(after!.n).toBe(0); // and the reconciler never touches billing_subscriptions
  });

  it("repairs a finite window UP to UNLIMITED when the plan says unlimited", async () => {
    const org = await seedOrg(90);
    await reconcile(listerOf(stripeSub(org, { retentionDays: "unlimited" })));
    expect(await windowOf(org)).toBeNull(); // NULL = unlimited
  });

  it("NEVER shrinks: an over-retained org is ALARMED, not auto-narrowed", async () => {
    // The org has MORE retention (90) than its plan entitles (30). Shrinking would delete data, so the
    // reconciler refuses to write and alarms instead. Over-retention is the safe miss.
    const org = await seedOrg(90);
    const logs: { m: string; f?: unknown }[] = [];
    const result = await reconcile(listerOf(stripeSub(org, { retentionDays: 30 })), (m, f) =>
      logs.push({ m, f }),
    );

    expect(await windowOf(org)).toBe(90); // UNCHANGED — never shrunk
    expect(result.repaired).toEqual([]);
    expect(result.overRetained).toEqual([{ orgId: org, from: 90, to: 30 }]);
    expect(logs.some((l) => l.m.includes("over_retained"))).toBe(true);
  });

  it("NEVER shrinks an UNLIMITED window down to a finite plan window", async () => {
    const org = await seedOrg(null); // unlimited (e.g. a legacy/enterprise grant)
    const result = await reconcile(listerOf(stripeSub(org, { retentionDays: 30 })));
    expect(await windowOf(org)).toBeNull(); // untouched
    expect(result.overRetained).toHaveLength(1);
  });

  it("is a no-op when the window already matches the plan", async () => {
    const org = await seedOrg(30);
    const result = await reconcile(listerOf(stripeSub(org, { retentionDays: 30 })));
    expect(result.repaired).toEqual([]);
    expect(result.overRetained).toEqual([]);
  });

  it("SKIPS a non-entitled subscription (incomplete/unpaid/paused) — it isn't a paying customer", async () => {
    const org = await seedOrg(7);
    const result = await reconcile(
      listerOf(stripeSub(org, { status: "incomplete", retentionDays: 30 })),
    );
    expect(await windowOf(org)).toBe(7); // untouched — not entitled
    expect(result.entitledChecked).toBe(0);
  });

  it("ALARMS (no repair) on an UNPARSEABLE subscription — the parser needs updating", async () => {
    const org = await seedOrg(7);
    const logs: { m: string }[] = [];
    // Missing period bounds → parseSubscriptionObject returns null.
    const bad = {
      id: "sub_x",
      customer: "cus_x",
      status: "active",
      metadata: { org_id: org },
      items: { data: [{ price: { id: "p", metadata: {} } }] },
    };
    const result = await reconcile(listerOf(bad), (m) => logs.push({ m }));

    expect(await windowOf(org)).toBe(7); // can't derive → don't touch
    expect(result.unparseable).toBe(1);
    expect(logs.some((l) => l.m.includes("unparseable"))).toBe(true);
  });

  it("handles a mix across many orgs and reports a summary", async () => {
    const stuck = await seedOrg(7);
    const ok = await seedOrg(30);
    const over = await seedOrg(90);
    const result = await reconcile(
      listerOf(
        stripeSub(stuck, { retentionDays: 30 }),
        stripeSub(ok, { retentionDays: 30 }),
        stripeSub(over, { retentionDays: 30 }),
      ),
    );
    expect(await windowOf(stuck)).toBe(30);
    expect(await windowOf(ok)).toBe(30);
    expect(await windowOf(over)).toBe(90);
    expect(result.entitledChecked).toBe(3);
    expect(result.repaired).toHaveLength(1);
    expect(result.overRetained).toHaveLength(1);
  });
});
