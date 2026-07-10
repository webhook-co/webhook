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
 *  synced subscription mirror row (null = never subscribed / no live sub) that readOrgBilling returns. */
function enableBilling(customerId: string | null, sub: unknown = null) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue({
    pro: { base: "price_base", overage: "price_overage" },
    scale: { base: "price_scale_base", overage: "price_scale_overage" },
  });
  env.getStripeSecretKey.mockResolvedValue("sk_test_x");
  db.withTenantDb.mockResolvedValue({ customerId, sub }); // short-circuits withTenant(readOrgBilling)
  const client = {
    createCheckoutSession: vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout" }),
    createPortalSession: vi.fn().mockResolvedValue({ id: "ps_1", url: "https://portal" }),
    createCustomer: vi.fn(),
    request: vi.fn(),
  };
  stripe.makeStripeClient.mockReturnValue(client);
  return client;
}

describe("startCheckout", () => {
  it("is disabled when BILLING_MODE is off (no Stripe client, no db read)", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await startCheckout("org-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(stripe.makeStripeClient).not.toHaveBeenCalled();
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("is disabled when the Stripe key is not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue({ pro: { base: "price_base", overage: "price_overage" } });
    env.getStripeSecretKey.mockResolvedValue(null);
    expect(await startCheckout("org-1", "pro")).toEqual({ status: "disabled" });
  });

  it("is disabled when the price ids are not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue(null);
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    expect(await startCheckout("org-1", "pro")).toEqual({ status: "disabled" });
  });

  it("for a NEW org (no customer) creates a session with the email prefilled", async () => {
    const client = enableBilling(null);
    const res = await startCheckout("org-7", "pro", "new@x.test");
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
    expect(await startCheckout("org-7", "pro", "a@b.test")).toEqual({
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
      expect(await startCheckout("org-7", "pro", "a@b.test")).toEqual({
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
    expect(await startCheckout("org-7", "pro", "a@b.test")).toEqual({
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
    expect(await startCheckout("org-7", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession.mock.calls[0][0].customer).toBe("cus_2");
  });

  it("maps a Stripe failure to 'error' (never throws)", async () => {
    const client = enableBilling(null);
    client.createCheckoutSession.mockRejectedValue(new Error("stripe down"));
    expect(await startCheckout("org-7", "pro", "a@b.test")).toEqual({ status: "error" });
  });
});

describe("openBillingPortal", () => {
  it("is disabled when BILLING_MODE is off", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await openBillingPortal("org-1")).toEqual({ status: "disabled" });
  });

  it("returns no_customer when the org has never subscribed", async () => {
    enableBilling(null);
    expect(await openBillingPortal("org-1")).toEqual({ status: "no_customer" });
  });

  it("opens the portal for an org with a customer", async () => {
    const client = enableBilling("cus_1");
    const res = await openBillingPortal("org-1");
    expect(res).toEqual({ status: "ok", url: "https://portal" });
    expect(client.createPortalSession.mock.calls[0][0].customer).toBe("cus_1");
  });
});

describe("startCheckout — plan gating (planId is untrusted form input)", () => {
  it("sells the requested plan's OWN price pair, not a hardcoded one", async () => {
    const client = enableBilling(null);
    expect(await startCheckout("org-9", "scale", "a@b.test")).toEqual({
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
    expect(await startCheckout("org-9", "enterprise", "a@b.test")).toEqual({
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
    expect(await startCheckout("org-9", "scale", "a@b.test")).toEqual({ status: "unknown_plan" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("startCheckout — the Stripe key must belong to BILLING_MODE", () => {
  it("refuses a LIVE key under BILLING_MODE=test (it would charge real cards)", async () => {
    const client = enableBilling(null);
    env.getStripeSecretKey.mockResolvedValue("sk_live_realmoney");
    expect(await startCheckout("org-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a TEST key under BILLING_MODE=live (it would take no money)", async () => {
    const client = enableBilling(null);
    env.getBillingMode.mockReturnValue("live");
    env.getStripeSecretKey.mockResolvedValue("sk_test_sandbox");
    expect(await startCheckout("org-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a PUBLISHABLE key used as a secret", async () => {
    const client = enableBilling(null);
    env.getStripeSecretKey.mockResolvedValue("pk_test_publishable");
    expect(await startCheckout("org-1", "pro", "a@b.test")).toEqual({ status: "disabled" });
    expect(client.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("allows the matching pair (live key + live mode)", async () => {
    const client = enableBilling(null);
    env.getBillingMode.mockReturnValue("live");
    env.getStripeSecretKey.mockResolvedValue("sk_live_realmoney");
    expect(await startCheckout("org-1", "pro", "a@b.test")).toEqual({
      status: "ok",
      url: "https://checkout",
    });
    expect(client.createCheckoutSession).toHaveBeenCalled();
  });
});

describe("loadBillingSummary (dedicated Billing section)", () => {
  function enable(sub: unknown, customerId: string | null) {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue({
      pro: { base: "price_base", overage: "price_overage" },
      scale: { base: "price_scale_base", overage: "price_scale_overage" },
    });
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    db.withTenantDb.mockResolvedValue({ customerId, sub });
  }

  it("hides when billing is off / plans unset / key mismatches mode", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await loadBillingSummary("org-1")).toMatchObject({ hidden: true });
    env.getBillingMode.mockReturnValue("test");
    env.getStripePlans.mockReturnValue(null);
    expect(await loadBillingSummary("org-1")).toMatchObject({ hidden: true });
    env.getStripePlans.mockReturnValue({ pro: { base: "b", overage: "o" } });
    env.getStripeSecretKey.mockResolvedValue("sk_live_x"); // live key under test mode → mismatch
    expect(await loadBillingSummary("org-1")).toMatchObject({ hidden: true });
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
    const v = await loadBillingSummary("org-1");
    expect(v.hidden).toBe(false);
    expect(v.display).toMatchObject({ tier: "pro", state: "active" });
    expect(v.upgradePlanIds).toEqual([]); // entitled → no picker
    expect(v.hasCustomer).toBe(true);
  });

  it("NO subscription → no display, upgrade picker (ladder order), no customer", async () => {
    enable(null, null);
    const v = await loadBillingSummary("org-1");
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
    const v = await loadBillingSummary("org-1");
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
    const v = await loadBillingSummary("org-1");
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
    const v = await loadBillingSummary("org-1");
    expect(v.display).toMatchObject({ state: "inactive" });
    expect(v.upgradePlanIds).toEqual([]); // live sub exists → never offer a duplicate
    expect(v.hasCustomer).toBe(true);
  });

  it("a customer with NO mirror sub row → NO picker (could be an unmirrored live sub)", async () => {
    enable(null, "cus_1");
    const v = await loadBillingSummary("org-1");
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
    const v = await loadBillingSummary("org-1");
    expect(v.display).toMatchObject({ tier: "pro", state: "active" });
    expect(v.upgradePlanIds).toEqual([]);
    expect(v.hasCustomer).toBe(false);
  });
});
