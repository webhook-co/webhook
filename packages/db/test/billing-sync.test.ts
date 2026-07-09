import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  applyCustomerLink,
  applySubscriptionDeleted,
  applySubscriptionUpsert,
  capMirrorDecision,
  parseCheckoutSession,
  parseSubscriptionObject,
  resolveOrgId,
  type ParsedSubscription,
} from "../src/billing-sync";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// S4.5b inbound state-sync: parse verified Stripe objects (org from SIGNED metadata) and apply them under
// the org's RLS as webhook_billing — customer link, subscription mirror + cap (increase-now/decrease-defer),
// downgrade — all watermark-guarded against out-of-order deliveries.

describe("resolveOrgId (pure)", () => {
  it("prefers client_reference_id, falls back to metadata.org_id, else null", () => {
    expect(resolveOrgId({ client_reference_id: "org-a" })).toBe("org-a");
    expect(resolveOrgId({ metadata: { org_id: "org-b" } })).toBe("org-b");
    expect(resolveOrgId({ client_reference_id: "org-a", metadata: { org_id: "org-b" } })).toBe(
      "org-a",
    );
    expect(resolveOrgId({ customer: "cus_1" })).toBeNull();
    expect(resolveOrgId({ metadata: {} })).toBeNull();
  });
});

describe("parseCheckoutSession (pure)", () => {
  it("extracts org + customer, or null when either is missing", () => {
    expect(parseCheckoutSession({ client_reference_id: "org-a", customer: "cus_1" })).toEqual({
      orgId: "org-a",
      customerId: "cus_1",
    });
    expect(parseCheckoutSession({ client_reference_id: "org-a" })).toBeNull(); // no customer
    expect(parseCheckoutSession({ customer: "cus_1" })).toBeNull(); // no org
  });
});

describe("parseSubscriptionObject (pure)", () => {
  const base = {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { org_id: "org-a" },
    current_period_start: Math.floor(Date.UTC(2026, 6, 1) / 1000),
    current_period_end: Math.floor(Date.UTC(2026, 7, 1) / 1000),
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_pro", metadata: { event_cap: "500000" } } }] },
  };

  it("parses a subscription with a cap from the price metadata + ISO period bounds", () => {
    const s = parseSubscriptionObject(base);
    expect(s).toMatchObject({
      orgId: "org-a",
      stripeSubscriptionId: "sub_1",
      customerId: "cus_1",
      plan: "price_pro",
      status: "active",
      eventCap: 500000,
      currentPeriodStartIso: "2026-07-01T00:00:00.000Z",
      currentPeriodEndIso: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
  });

  it("cap: explicit 'unlimited' → null; absent/garbage → undefined (fail-closed, not unlimited)", () => {
    const cap = (price: Record<string, unknown>) =>
      parseSubscriptionObject({ ...base, items: { data: [{ price }] } })?.eventCap;
    expect(cap({ id: "p", metadata: { event_cap: "unlimited" } })).toBeNull(); // explicit unlimited
    expect(cap({ id: "p" })).toBeUndefined(); // no metadata → unspecified
    expect(cap({ id: "p", metadata: { event_cap: "lots" } })).toBeUndefined(); // garbage → unspecified
    expect(cap({ id: "p", metadata: { event_cap: "0" } })).toBeUndefined(); // non-positive → unspecified
  });

  it("falls back to the ITEM's period bounds when the top-level ones are absent (newer Stripe API)", () => {
    const noTop = { ...base } as Record<string, unknown>;
    delete noTop.current_period_start;
    delete noTop.current_period_end;
    const s = parseSubscriptionObject({
      ...noTop,
      items: {
        data: [
          {
            price: { id: "price_pro", metadata: { event_cap: "500000" } },
            current_period_start: Math.floor(Date.UTC(2026, 6, 1) / 1000),
            current_period_end: Math.floor(Date.UTC(2026, 7, 1) / 1000),
          },
        ],
      },
    });
    expect(s?.currentPeriodStartIso).toBe("2026-07-01T00:00:00.000Z");
    expect(s?.currentPeriodEndIso).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns null when a required field is missing (no period at top OR item level)", () => {
    const noPeriod = { ...base } as Record<string, unknown>;
    delete noPeriod.current_period_end;
    expect(parseSubscriptionObject(noPeriod)).toBeNull();
    expect(parseSubscriptionObject({ ...base, metadata: {} })).toBeNull(); // no org
  });
});

describe("capMirrorDecision (pure) — increase-now, decrease-defer", () => {
  it("establishes the cap for a brand-new paid org (no existing row)", () => {
    expect(capMirrorDecision(undefined, 500000)).toEqual({ apply: true, value: 500000 });
    expect(capMirrorDecision(undefined, null)).toEqual({ apply: true, value: null });
  });
  it("applies an INCREASE immediately", () => {
    expect(capMirrorDecision(100000, 500000)).toEqual({ apply: true, value: 500000 });
    expect(capMirrorDecision(500000, null)).toEqual({ apply: true, value: null }); // → unlimited
  });
  it("DEFERS a decrease (leaves the more generous cap in place)", () => {
    expect(capMirrorDecision(500000, 100000)).toEqual({ apply: false, value: 500000 });
    expect(capMirrorDecision(null, 100000)).toEqual({ apply: false, value: null }); // unlimited → capped
  });
  it("is a no-op on an equal cap", () => {
    expect(capMirrorDecision(500000, 500000)).toEqual({ apply: false, value: 500000 });
    expect(capMirrorDecision(null, null)).toEqual({ apply: false, value: null });
  });
});

// ---- integration (ephemeral pg, webhook_billing under RLS) ----

let pg: EphemeralPostgres;
let app: Sql;
let billing: Sql;
let admin: Sql;

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

function sub(orgId: string, overrides: Partial<ParsedSubscription> = {}): ParsedSubscription {
  return {
    orgId,
    stripeSubscriptionId: "sub_" + orgId.slice(0, 6),
    customerId: "cus_" + orgId.slice(0, 6),
    plan: "price_pro",
    status: "active",
    eventCap: 500000,
    currentPeriodStartIso: "2026-07-01T00:00:00.000Z",
    currentPeriodEndIso: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

async function readSub(orgId: string) {
  const [row] = await admin<
    { status: string; event_cap: string | null; last: string }[]
  >`select status, event_cap::text as event_cap, last_stripe_event_created::text as last
    from billing_subscriptions where org_id = ${orgId}`;
  return row;
}
async function readCap(orgId: string): Promise<number | null | undefined> {
  const [row] = await admin<{ event_cap: string | null }[]>`
    select event_cap::text as event_cap from org_limits where org_id = ${orgId}`;
  return row ? (row.event_cap === null ? null : Number(row.event_cap)) : undefined;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  billing = createClient(pg.urlFor({ role: DB_ROLES.billing }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from org_limits`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from billing_customers`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await billing?.end();
  await admin?.end();
  await pg?.stop();
});

describe("applyCustomerLink (integration)", () => {
  it("links the org to its Stripe customer, idempotently", async () => {
    const org = await seedOrg();
    await applyCustomerLink(billing, { orgId: org, customerId: "cus_A" });
    const [row1] = await admin<{ stripe_customer_id: string }[]>`
      select stripe_customer_id from billing_customers where org_id = ${org}`;
    expect(row1.stripe_customer_id).toBe("cus_A");
    // A re-link (same org) updates in place, no duplicate.
    await applyCustomerLink(billing, { orgId: org, customerId: "cus_A2" });
    const rows = await admin<{ stripe_customer_id: string }[]>`
      select stripe_customer_id from billing_customers where org_id = ${org}`;
    expect(rows.map((r) => r.stripe_customer_id)).toEqual(["cus_A2"]);
  });
});

describe("applySubscriptionUpsert (integration)", () => {
  it("creates the subscription mirror + establishes the org_limits cap", async () => {
    const org = await seedOrg();
    const res = await applySubscriptionUpsert(billing, sub(org, { eventCap: 500000 }), 1000);
    expect(res).toBe("applied");
    expect(await readSub(org)).toMatchObject({
      status: "active",
      event_cap: "500000",
      last: "1000",
    });
    expect(await readCap(org)).toBe(500000);
  });

  it("IGNORES a strictly-older event via the watermark (out-of-order guard)", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 2000);
    // A stale 'canceled' with an older created must NOT overwrite the newer 'active'.
    const stale = await applySubscriptionUpsert(billing, sub(org, { status: "canceled" }), 1500);
    expect(stale).toBe("stale");
    expect((await readSub(org)).status).toBe("active");
  });

  it("APPLIES a same-second (equal created) event — last-write-wins (created is second-granular)", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { status: "trialing" }), 1000);
    // A distinct event in the same second (e.g. trialing→active) must still apply, not be dropped as stale.
    const res = await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 1000);
    expect(res).toBe("applied");
    expect((await readSub(org)).status).toBe("active");
  });

  it("REJECTS a subscription whose Stripe customer ≠ the org's linked customer (identity binding)", async () => {
    const org = await seedOrg();
    await applyCustomerLink(billing, { orgId: org, customerId: "cus_A" });
    // A subscription event carrying a DIFFERENT customer for this org is a bug/attack — refuse to mutate.
    const res = await applySubscriptionUpsert(billing, sub(org, { customerId: "cus_B" }), 1000);
    expect(res).toBe("customer_mismatch");
    expect(await readSub(org)).toBeUndefined(); // nothing written
    // The matching customer applies normally.
    expect(await applySubscriptionUpsert(billing, sub(org, { customerId: "cus_A" }), 1000)).toBe(
      "applied",
    );
  });

  it("FAIL-CLOSED: an UNSPECIFIED cap (bad/absent price metadata) never changes org_limits", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 100000 }), 1000);
    expect(await readCap(org)).toBe(100000);
    // A later event whose price cap is unspecified must NOT grant unlimited — the cap stays put.
    const res = await applySubscriptionUpsert(billing, sub(org, { eventCap: undefined }), 2000);
    expect(res).toBe("applied"); // the subscription row still updates
    expect(await readCap(org)).toBe(100000); // but the enforced cap is unchanged (not unlimited)
  });

  it("applies a cap INCREASE immediately but DEFERS a decrease", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 100000 }), 1000);
    expect(await readCap(org)).toBe(100000);
    // Upgrade → cap raised now.
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 500000 }), 2000);
    expect(await readCap(org)).toBe(500000);
    // Downgrade → org_limits cap stays at the higher value (decrease deferred to the period boundary),
    // even though billing_subscriptions.event_cap reflects the new lower plan.
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 100000 }), 3000);
    expect(await readCap(org)).toBe(500000);
    expect((await readSub(org)).event_cap).toBe("100000");
  });

  it("applies the DEFERRED decrease at the period boundary (a renewal advances the period)", async () => {
    const org = await seedOrg();
    const p1 = { currentPeriodStartIso: "2026-07-01T00:00:00.000Z" };
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 500000, ...p1 }), 1000);
    // Mid-period downgrade → deferred (cap stays high).
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 100000, ...p1 }), 2000);
    expect(await readCap(org)).toBe(500000);
    // Renewal: the period ADVANCES (later current_period_start) → the deferred decrease lands now.
    await applySubscriptionUpsert(
      billing,
      sub(org, {
        eventCap: 100000,
        currentPeriodStartIso: "2026-08-01T00:00:00.000Z",
        currentPeriodEndIso: "2026-09-01T00:00:00.000Z",
      }),
      3000,
    );
    expect(await readCap(org)).toBe(100000);
  });
});

describe("applySubscriptionDeleted (integration)", () => {
  it("marks canceled and REMOVES the paid cap (→ Free default)", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { eventCap: 500000 }), 1000);
    expect(await readCap(org)).toBe(500000);
    const res = await applySubscriptionDeleted(billing, { orgId: org, eventCreated: 2000 });
    expect(res).toBe("applied");
    expect((await readSub(org)).status).toBe("canceled");
    expect(await readCap(org)).toBeUndefined(); // org_limits row gone → falls back to Free default
  });

  it("is a stale no-op when an older-or-equal event arrives after a newer one", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org), 5000);
    const res = await applySubscriptionDeleted(billing, { orgId: org, eventCreated: 4000 });
    expect(res).toBe("stale");
    expect((await readSub(org)).status).toBe("active"); // untouched
  });

  it("is idempotent when the org has no subscription", async () => {
    const org = await seedOrg();
    const res = await applySubscriptionDeleted(billing, { orgId: org, eventCreated: 1 });
    expect(res).toBe("applied");
  });
});

describe("webhook_billing cross-tenant write rejection (behavioral RLS WITH CHECK)", () => {
  it("cannot write ANOTHER org's billing rows, even under its own tenant context", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    // As webhook_billing under org A's RLS context, every attempt to write org B's row must be rejected by
    // the WITH CHECK (org_id = current_org_id()) — the writer is confined to the org it resolved from Stripe.
    await expect(
      withTenant(
        billing,
        a,
        (tx) =>
          tx`insert into billing_customers (org_id, stripe_customer_id) values (${b}, ${"cus_B"})`,
      ),
    ).rejects.toThrow(/row-level security|policy|violates/i);
    await expect(
      withTenant(
        billing,
        a,
        (tx) => tx`
          insert into billing_subscriptions
            (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
          values (${b}, ${"sub_B"}, ${"pro"}, ${"active"},
                  ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`,
      ),
    ).rejects.toThrow(/row-level security|policy|violates/i);
    await expect(
      withTenant(
        billing,
        a,
        (tx) => tx`insert into org_limits (org_id, event_cap) values (${b}, ${100})`,
      ),
    ).rejects.toThrow(/row-level security|policy|violates/i);
    // And an UPDATE of org B's existing row from org A's context is a silent no-op (RLS hides the row), not a
    // cross-tenant mutation: seed B's customer as root, then try to overwrite it as billing under A.
    await admin`insert into billing_customers (org_id, stripe_customer_id) values (${b}, ${"cus_owned"})`;
    await withTenant(
      billing,
      a,
      (tx) =>
        tx`update billing_customers set stripe_customer_id = ${"cus_HIJACK"} where org_id = ${b}`,
    );
    const [{ stripe_customer_id }] = await admin<{ stripe_customer_id: string }[]>`
      select stripe_customer_id from billing_customers where org_id = ${b}`;
    expect(stripe_customer_id).toBe("cus_owned"); // untouched
  });
});

describe("applySubscriptionUpsert — a NON-ENTITLED status drops the paid cap mirror", () => {
  it("keeps the paid cap while past_due (dunning is a grace window, not a downgrade)", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 1000);
    expect(await readCap(org)).toBe(500000);
    await applySubscriptionUpsert(billing, sub(org, { status: "past_due" }), 2000);
    expect(await readCap(org)).toBe(500000); // still entitled — a failed card must not pause a customer
  });

  for (const status of ["unpaid", "incomplete", "incomplete_expired", "paused"] as const) {
    it(`removes the paid cap on '${status}' → the org falls back to the Free default`, async () => {
      // Stripe only writes 'canceled' on subscription.deleted, so without this the org would keep a paid
      // org_limits cap while effectiveBillingPeriod has already dropped it to the Free lifetime basis.
      const org = await seedOrg();
      await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 1000);
      expect(await readCap(org)).toBe(500000);
      const r = await applySubscriptionUpsert(billing, sub(org, { status }), 2000);
      expect(r).toBe("applied");
      expect(await readCap(org)).toBeUndefined(); // no org_limits row → injected Free default
      expect((await readSub(org)).status).toBe(status); // the status itself is still mirrored
    });
  }

  it("RE-establishes the cap when the org becomes entitled again (unpaid → active)", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 1000);
    await applySubscriptionUpsert(billing, sub(org, { status: "unpaid" }), 2000);
    expect(await readCap(org)).toBeUndefined();
    await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 3000);
    expect(await readCap(org)).toBe(500000); // current === undefined → establish, no decrease-defer stall
  });

  it("does not resurrect a cap for a non-entitled status whose event is STALE", async () => {
    const org = await seedOrg();
    await applySubscriptionUpsert(billing, sub(org, { status: "active" }), 3000);
    const r = await applySubscriptionUpsert(billing, sub(org, { status: "unpaid" }), 1500);
    expect(r).toBe("stale");
    expect(await readCap(org)).toBe(500000); // the stale downgrade never applied
  });
});

describe("parseSubscriptionObject — the cap may live on ANY item, not items[0]", () => {
  /** A real Checkout subscription: a licensed BASE item plus a metered OVERAGE item. `event_cap` lives on
   *  the overage price, because that is the price the meter is attached to. Which item Stripe returns first
   *  is not a contract we control. */
  const twoItem = (order: "base-first" | "overage-first") => {
    const base = {
      price: { id: "price_base", metadata: {}, recurring: { usage_type: "licensed" } },
    };
    const overage = {
      price: {
        id: "price_over",
        metadata: { event_cap: "500000" },
        recurring: { usage_type: "metered" },
      },
    };
    return {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { org_id: "11111111-1111-1111-1111-111111111111" },
      current_period_start: 1_780_000_000,
      current_period_end: 1_782_000_000,
      items: { data: order === "base-first" ? [base, overage] : [overage, base] },
    };
  };

  it("finds event_cap on the OVERAGE item even when the BASE item comes first", () => {
    // The prod bug: reading items.data[0] only. Checkout puts the licensed base first, so the cap was
    // never seen, parseCapFromPriceMetadata returned undefined, and the fail-closed path skipped the
    // mirror entirely — a paying customer silently kept the Free cap.
    expect(parseSubscriptionObject(twoItem("base-first"))?.eventCap).toBe(500000);
  });

  it("finds it when the overage item comes first (order is not a contract)", () => {
    expect(parseSubscriptionObject(twoItem("overage-first"))?.eventCap).toBe(500000);
  });

  it("still fails CLOSED when NO item carries a cap (a misconfigured price must not grant unlimited)", () => {
    const noCap = {
      ...twoItem("base-first"),
      items: {
        data: [
          { price: { id: "a", metadata: {}, recurring: { usage_type: "licensed" } } },
          { price: { id: "b", metadata: {}, recurring: { usage_type: "metered" } } },
        ],
      },
    };
    expect(parseSubscriptionObject(noCap)?.eventCap).toBeUndefined();
  });

  it("honours an explicit `unlimited` on any item", () => {
    const unlimited = {
      ...twoItem("base-first"),
      items: {
        data: [
          { price: { id: "a", metadata: {}, recurring: { usage_type: "licensed" } } },
          {
            price: {
              id: "b",
              metadata: { event_cap: "unlimited" },
              recurring: { usage_type: "metered" },
            },
          },
        ],
      },
    };
    expect(parseSubscriptionObject(unlimited)?.eventCap).toBeNull();
  });

  it("plan is the LICENSED base price id, not whichever item happened to be first", () => {
    expect(parseSubscriptionObject(twoItem("overage-first"))?.plan).toBe("price_base");
    expect(parseSubscriptionObject(twoItem("base-first"))?.plan).toBe("price_base");
  });
});
