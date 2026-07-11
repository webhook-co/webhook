import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the env accessors, the tenant-db seam, and makeStripeClient — billing.ts is thin orchestration, so
// we drive it with fakes and assert the gating + argument shaping. billingEnabled stays REAL (the gate).
const env = vi.hoisted(() => ({
  getBillingMode: vi.fn(),
  getStripePlans: vi.fn(),
  getStripeSecretKey: vi.fn(),
}));
vi.mock("./env", () => env);

const db = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("./db", () => db);
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

const stripe = vi.hoisted(() => ({ makeStripeClient: vi.fn() }));
vi.mock("@webhook-co/shared", async (orig) => ({
  ...(await orig<typeof import("@webhook-co/shared")>()),
  makeStripeClient: stripe.makeStripeClient,
}));

import { loadBillingSummary, openBillingPortal, startCheckout } from "./billing";

afterEach(() => vi.clearAllMocks());

/** Configure a fully-enabled billing env + a fake Stripe client that records calls. `sub` is the org's
 *  synced subscription mirror row (null = never subscribed / no live sub) that readOrgBilling returns.
 *  `role` is the ACTING USER's membership role — owner by default, so the money paths are exercised as a
 *  billing manager unless a test says otherwise. */
function enableBilling(
  customerId: string | null,
  sub: unknown = null,
  role: string | null = "owner",
) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue({
    pro: { base: "price_base", overage: "price_overage" },
    scale: { base: "price_scale_base", overage: "price_scale_overage" },
  });
  env.getStripeSecretKey.mockResolvedValue("sk_test_x");
  db.withTenantDb.mockResolvedValue({ customerId, sub, role }); // short-circuits withTenant(readOrgBilling)
  const client = {
    createCheckoutSession: vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout" }),
    createPortalSession: vi.fn().mockResolvedValue({ id: "ps_1", url: "https://portal" }),
    createCustomer: vi.fn(),
    request: vi.fn(),
  };
  stripe.makeStripeClient.mockReturnValue(client);
  return client;
}

// The billing-manager gate on the two MONEY paths. switchPlan/cancelDowngrade/setOverage already gate
// owner/admin server-side; Checkout and the Customer Portal did not — they took no userId at all, so
// `canManageBilling` was decorative, used only to hide buttons. A plain member could POST the server action
// directly and open the Portal: cancel the subscription, change the card, read every invoice.
describe("billing-manager gate (S.2)", () => {
  it("startCheckout refuses a plain member and never reaches Stripe", async () => {
    const client = enableBilling(null, null, "member");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({ status: "forbidden" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("openBillingPortal refuses a plain member and never reaches Stripe", async () => {
    const client = enableBilling("cus_1", null, "member");
    expect(await openBillingPortal("org-1", "u-1")).toEqual({ status: "forbidden" });
    expect(client.createPortalSession).not.toHaveBeenCalled();
  });

  it("refuses a user with NO membership row (null role)", async () => {
    const client = enableBilling("cus_1", null, null);
    expect(await openBillingPortal("org-1", "u-1")).toEqual({ status: "forbidden" });
    expect(client.createPortalSession).not.toHaveBeenCalled();
  });

  it("admin is a billing manager — Checkout proceeds", async () => {
    const client = enableBilling(null, null, "admin");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession).toHaveBeenCalled();
  });
});

describe("startCheckout", () => {
  it("is disabled when BILLING_MODE is off (no Stripe client, no db read)", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(stripe.makeStripeClient).not.toHaveBeenCalled();
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("is disabled when the Stripe key is not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue({ pro: { base: "price_base", overage: "price_overage" } });
    env.getStripeSecretKey.mockResolvedValue(null);
    expect(await startCheckout("org-1", "u-1", "pro")).toEqual({ status: "disabled" });
  });

  it("is disabled when the price ids are not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue(null);
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    expect(await startCheckout("org-1", "u-1", "pro")).toEqual({ status: "disabled" });
  });

  it("for a NEW org (no customer) creates a session with the email prefilled", async () => {
    const client = enableBilling(null);
    const res = await startCheckout("org-7", "u-1", "pro", "new@x.test");
    expect(res).toEqual({ status: "ok", url: "https://checkout" });
    const args = client.createCheckoutSession.mock.calls[0][0];
    expect(args.customer).toBeUndefined();
    expect(args.customerEmail).toBe("new@x.test");
    expect(args.orgId).toBe("org-7");
    expect(args.lineItems).toEqual([
      { price: "price_base", quantity: 1 },
      { price: "price_overage" },
    ]);
  });

  it("REFUSES a Checkout for a customer with NO mirror sub row (matches the hidden picker)", async () => {
    // A customer exists but no subscription is mirrored — possibly an unmirrored live sub (the two setup
    // webhooks can land out of order). The server refuses exactly as the UI hides the picker, so a forged
    // POST can't slip through. (A genuine resubscribe has a `canceled` mirror row — see the next test.)
    const client = enableBilling("cus_existing"); // sub=null
    expect(await startCheckout("org-7", "u-1", "pro", "a@b.test")).toEqual({
      status: "already_subscribed",
    });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("REFUSES a new Checkout when a LIVE subscription exists — never double-subscribes", async () => {
    // The core double-subscribe guard: an org with a still-living Stripe sub (even a non-entitled one like
    // unpaid/paused) must NOT get a fresh Checkout, which would create a second concurrent subscription.
    for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]) {
      const client = enableBilling("cus_live", {
        plan: "price_base",
        status,
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      });
      expect(await startCheckout("org-7", "u-1", "pro", "a@b.test")).toEqual({
        status: "already_subscribed",
      });
      expect(client.createCheckoutSession).not.toHaveBeenCalled();
    }
  });

  it("ALLOWS a Checkout when the existing sub is terminal (canceled) — a real resubscribe", async () => {
    const client = enableBilling("cus_1", {
      plan: "price_base",
      status: "canceled",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    });
    expect(await startCheckout("org-7", "u-1", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession.mock.calls[0][0].customer).toBe("cus_1");
  });

  it("ALLOWS a Checkout when the existing sub is terminal (incomplete_expired) — a real resubscribe", async () => {
    const client = enableBilling("cus_2", {
      plan: "price_base",
      status: "incomplete_expired",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
    expect(await startCheckout("org-7", "u-1", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession.mock.calls[0][0].customer).toBe("cus_2");
  });

  it("maps a Stripe failure to 'error' (never throws)", async () => {
    const client = enableBilling(null);
    client.createCheckoutSession.mockRejectedValue(new Error("stripe down"));
    expect(await startCheckout("org-7", "u-1", "pro", "a@b.test")).toEqual({ status: "error" });
  });
});

describe("openBillingPortal", () => {
  it("is disabled when BILLING_MODE is off", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await openBillingPortal("org-1", "u-1")).toEqual({ status: "disabled" });
  });

  it("returns no_customer when the org has never subscribed", async () => {
    enableBilling(null);
    expect(await openBillingPortal("org-1", "u-1")).toEqual({ status: "no_customer" });
  });

  it("opens the portal for an org with a customer", async () => {
    const client = enableBilling("cus_1");
    const res = await openBillingPortal("org-1", "u-1");
    expect(res).toEqual({ status: "ok", url: "https://portal" });
    expect(client.createPortalSession.mock.calls[0][0].customer).toBe("cus_1");
  });
});

describe("startCheckout — plan gating (planId is untrusted form input)", () => {
  it("sells the requested plan's OWN price pair, not a hardcoded one", async () => {
    const client = enableBilling(null);
    expect(await startCheckout("org-9", "u-1", "scale", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession.mock.calls[0][0].lineItems).toEqual([
      { price: "price_scale_base", quantity: 1 },
      { price: "price_scale_overage" },
    ]);
  });

  it("rejects a contact-sales plan — enterprise never reaches Stripe", async () => {
    const client = enableBilling(null);
    expect(await startCheckout("org-9", "u-1", "enterprise", "a@b.test")).toEqual({
      status: "unknown_plan",
    });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown/garbage plan id BEFORE any Stripe call", async () => {
    const client = enableBilling(null);
    for (const bad of ["free", "", "pro; drop table", "__proto__"]) {
      expect(await startCheckout("org-9", bad, "a@b.test")).toEqual({ status: "unknown_plan" });
    }
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects a self-serve plan this deploy has no prices for (partial config)", async () => {
    const client = enableBilling(null);
    env.getStripePlans.mockReturnValue({ pro: { base: "price_base", overage: "price_overage" } });
    expect(await startCheckout("org-9", "u-1", "scale", "a@b.test")).toEqual({
      status: "unknown_plan",
    });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("startCheckout — the Stripe key must belong to BILLING_MODE", () => {
  it("refuses a LIVE key under BILLING_MODE=test (it would charge real cards)", async () => {
    const client = enableBilling(null);
    env.getStripeSecretKey.mockResolvedValue("sk_live_realmoney");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a TEST key under BILLING_MODE=live (it would take no money)", async () => {
    const client = enableBilling(null);
    env.getBillingMode.mockReturnValue("live");
    env.getStripeSecretKey.mockResolvedValue("sk_test_sandbox");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a PUBLISHABLE key used as a secret", async () => {
    const client = enableBilling(null);
    env.getStripeSecretKey.mockResolvedValue("pk_test_publishable");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("allows the matching pair (live key + live mode)", async () => {
    const client = enableBilling(null);
    env.getBillingMode.mockReturnValue("live");
    env.getStripeSecretKey.mockResolvedValue("sk_live_realmoney");
    expect(await startCheckout("org-1", "u-1", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession).toHaveBeenCalled();
  });
});

describe("loadBillingSummary (dedicated Billing section)", () => {
  function enable(
    sub: unknown,
    customerId: string | null,
    overagePolicy: "pause" | "allow" | null = null,
    role: "owner" | "admin" | "member" | null = "owner",
  ) {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue({
      pro: { base: "price_base", overage: "price_overage" },
      scale: { base: "price_scale_base", overage: "price_scale_overage" },
    });
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    db.withTenantDb.mockResolvedValue({ customerId, sub, overagePolicy, role });
  }

  it("hides when billing is off / plans unset / key mismatches mode", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await loadBillingSummary("org-1", "user-1")).toMatchObject({ hidden: true });
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue(null);
    expect(await loadBillingSummary("org-1", "user-1")).toMatchObject({ hidden: true });
    env.getStripePlans.mockReturnValue({ pro: { base: "b", overage: "o" } });
    env.getStripeSecretKey.mockResolvedValue("sk_live_x"); // live key under test mode → mismatch
    expect(await loadBillingSummary("org-1", "user-1")).toMatchObject({ hidden: true });
  });

  it("an ACTIVE subscription → current-plan display, NO upgrade picker, has customer", async () => {
    enable(
      {
        plan: "price_base",
        status: "active",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      "cus_1",
    );
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.hidden).toBe(false);
    expect(v.display).toMatchObject({ tier: "pro", state: "active" });
    expect(v.upgradePlanIds).toEqual([]); // entitled → no picker
    expect(v.hasCustomer).toBe(true);
  });

  it("NO subscription → no display, upgrade picker (ladder order), no customer", async () => {
    enable(null, null);
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toBeNull();
    expect(v.upgradePlanIds).toEqual(["pro", "scale"]);
    expect(v.hasCustomer).toBe(false);
  });

  it("a CANCELED subscription → canceled display AND a resubscribe picker (has customer for the Portal)", async () => {
    enable(
      {
        plan: "price_base",
        status: "canceled",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: true,
      },
      "cus_1",
    );
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toMatchObject({ state: "canceled" });
    expect(v.upgradePlanIds).toEqual(["pro", "scale"]); // terminal sub → safe to offer resubscribe
    expect(v.hasCustomer).toBe(true);
  });

  it("a CANCELING sub (active + cancel_at_period_end) is still entitled → NO picker, has customer", async () => {
    enable(
      {
        plan: "price_base",
        status: "active",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: true,
      },
      "cus_1",
    );
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toMatchObject({ state: "canceling" });
    expect(v.upgradePlanIds).toEqual([]); // still a live sub → no duplicate; cancel/manage via Portal
    expect(v.hasCustomer).toBe(true);
  });

  it("an INACTIVE (unpaid) sub still LIVES → NO picker (a Checkout would double-subscribe; use Portal)", async () => {
    enable(
      {
        plan: "price_base",
        status: "unpaid",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      "cus_1",
    );
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toMatchObject({ state: "inactive" });
    expect(v.upgradePlanIds).toEqual([]); // live sub exists → never offer a duplicate
    expect(v.hasCustomer).toBe(true);
  });

  it("a customer with NO mirror sub row → NO picker (could be an unmirrored live sub)", async () => {
    enable(null, "cus_1");
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toBeNull();
    expect(v.upgradePlanIds).toEqual([]); // conservative: don't invite a Checkout we can't prove is safe
    expect(v.hasCustomer).toBe(true);
  });

  it("a LIVE sub whose customer hasn't mirrored yet → display, NO picker, NO customer (sync-race)", async () => {
    // Reverse-ordered setup webhooks: the subscription mirrored before its billing_customers row. The page
    // shows the plan but neither a picker (would double-subscribe) nor the Portal (no customer id) — it
    // renders a transient "finishing setup" note off exactly this shape.
    enable(
      {
        plan: "price_base",
        status: "active",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      null,
    );
    const v = await loadBillingSummary("org-1", "user-1");
    expect(v.display).toMatchObject({ tier: "pro", state: "active" });
    expect(v.upgradePlanIds).toEqual([]);
    expect(v.hasCustomer).toBe(false);
  });

  it("maps the overage policy → overageEnabled (null when no paid org_limits row)", async () => {
    const sub = {
      plan: "price_base",
      status: "active",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    enable(sub, "cus_1", "allow");
    expect((await loadBillingSummary("org-1", "user-1")).overageEnabled).toBe(true);
    enable(sub, "cus_1", "pause");
    expect((await loadBillingSummary("org-1", "user-1")).overageEnabled).toBe(false);
    enable(sub, "cus_1", null); // no org_limits row → toggle doesn't apply
    expect((await loadBillingSummary("org-1", "user-1")).overageEnabled).toBeNull();
  });

  it("switchTargets offers the OTHER self-serve plan for a live sub, empty for a canceled one", async () => {
    const active = {
      plan: "price_base", // pro's base
      status: "active",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    enable(active, "cus_1", "pause");
    expect((await loadBillingSummary("org-1", "user-1")).switchTargets).toEqual(["scale"]);
    // On Scale → offer Pro.
    enable({ ...active, plan: "price_scale_base" }, "cus_1", "pause");
    expect((await loadBillingSummary("org-1", "user-1")).switchTargets).toEqual(["pro"]);
    // A canceled sub isn't live → nothing to switch in place (resubscribe instead).
    enable({ ...active, status: "canceled" }, "cus_1", null);
    expect((await loadBillingSummary("org-1", "user-1")).switchTargets).toEqual([]);
    // A non-entitled live sub (unpaid) isn't switchable in place.
    enable({ ...active, status: "unpaid" }, "cus_1", null);
    expect((await loadBillingSummary("org-1", "user-1")).switchTargets).toEqual([]);
    // A legacy/unknown base price → tier unknown → no switch targets.
    enable({ ...active, plan: "price_legacy" }, "cus_1", "pause");
    expect((await loadBillingSummary("org-1", "user-1")).switchTargets).toEqual([]);
  });

  it("canManageBilling is true only for an owner/admin (gates the overage toggle button)", async () => {
    const sub = {
      plan: "price_base",
      status: "active",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    enable(sub, "cus_1", "pause", "owner");
    expect((await loadBillingSummary("org-1", "user-1")).canManageBilling).toBe(true);
    enable(sub, "cus_1", "pause", "admin");
    expect((await loadBillingSummary("org-1", "user-1")).canManageBilling).toBe(true);
    enable(sub, "cus_1", "pause", "member");
    expect((await loadBillingSummary("org-1", "user-1")).canManageBilling).toBe(false);
    enable(sub, "cus_1", "pause", null); // not a member
    expect((await loadBillingSummary("org-1", "user-1")).canManageBilling).toBe(false);
  });
});

// ── The pending downgrade the billing page shows on every visit (ADR-0112) ──────────────────────────────────

describe("loadBillingSummary — a booked downgrade", () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);
  const FUTURE = NOW_SEC + 86_400 * 10;

  /** An entitled SCALE org whose subscription carries a schedule booking a move to Pro at period end. */
  function enableWithSchedule(over: Record<string, unknown> = {}) {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue({
      pro: { base: "price_base", overage: "price_overage" },
      scale: { base: "price_scale_base", overage: "price_scale_overage" },
    });
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    db.withTenantDb.mockResolvedValue({
      customerId: "cus_1",
      sub: {
        plan: "price_scale_base", // on Scale
        status: "active",
        currentPeriodEnd: new Date(FUTURE * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      },
      subscriptionId: "sub_1",
      overagePolicy: "pause",
      role: "owner",
    });
    const client = {
      retrieveSubscription: vi.fn().mockResolvedValue({
        id: "sub_1",
        status: "active",
        items: [],
        scheduleId: "sub_sched_1",
      }),
      retrieveSubscriptionSchedule: vi.fn().mockResolvedValue({
        id: "sub_sched_1",
        currentPhase: { items: [] },
        phases: [
          { startDate: NOW_SEC - 100, endDate: FUTURE, items: [{ price: "price_scale_base" }] },
          { startDate: FUTURE, items: [{ price: "price_base" }] }, // → Pro, in the future
        ],
      }),
      ...over,
    };
    stripe.makeStripeClient.mockReturnValue(client);
    return client;
  }

  it("reports the booked plan + when it takes effect, and stops offering that plan as a switch target", async () => {
    enableWithSchedule();

    const view = await loadBillingSummary("org-1", "user-1");

    expect(view.pendingDowngrade).toEqual({ plan: "pro", effectiveAt: FUTURE });
    // Offering "Switch to Pro" when Pro is ALREADY booked would read as a dead no-op button.
    expect(view.switchTargets).toEqual([]);
    expect(view.hidden).toBe(false);
  });

  it("reports nothing pending when the subscription carries no schedule", async () => {
    enableWithSchedule({
      retrieveSubscription: vi
        .fn()
        .mockResolvedValue({ id: "sub_1", status: "active", items: [], scheduleId: null }),
    });

    const view = await loadBillingSummary("org-1", "user-1");

    expect(view.pendingDowngrade).toBeNull();
    expect(view.switchTargets).toEqual(["pro"]); // a Scale org can still switch down
  });

  it("a Stripe FAULT hides only the downgrade notice — never the whole billing panel", async () => {
    // The contract that matters: readPendingDowngrade is best-effort. If a Stripe blip escaped to the outer
    // catch, every paying customer would see "Billing isn't available right now" instead of their plan.
    const { logActionError } = await import("./action-log");
    enableWithSchedule({
      retrieveSubscription: vi.fn().mockRejectedValue(new Error("stripe down")),
    });

    const view = await loadBillingSummary("org-1", "user-1");

    expect(view.hidden).toBe(false); // the panel still renders
    expect(view.pendingDowngrade).toBeNull(); // just without the notice
    expect(view.display).not.toBeNull(); // and the plan card is intact
    expect(vi.mocked(logActionError)).toHaveBeenCalledWith(
      "billing.pending_downgrade_read_failed",
      expect.any(Error),
    );
    // NOT the outer summary failure — that would mean it took the whole page down.
    expect(vi.mocked(logActionError)).not.toHaveBeenCalledWith(
      "billing.summary_failed",
      expect.anything(),
    );
  });

  it("survives a fault reading the SCHEDULE itself (the second Stripe call), too", async () => {
    enableWithSchedule({
      retrieveSubscriptionSchedule: vi.fn().mockRejectedValue(new Error("stripe down")),
    });

    const view = await loadBillingSummary("org-1", "user-1");

    expect(view.hidden).toBe(false);
    expect(view.pendingDowngrade).toBeNull();
  });
});
