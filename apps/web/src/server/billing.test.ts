import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the env accessors, the tenant-db seam, and makeStripeClient — billing.ts is thin orchestration, so
// we drive it with fakes and assert the gating + argument shaping. billingEnabled stays REAL (the gate).
const env = vi.hoisted(() => ({
  getBillingMode: vi.fn(),
  getStripePriceIds: vi.fn(),
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

import { openBillingPortal, startCheckout } from "./billing";

afterEach(() => vi.clearAllMocks());

/** Configure a fully-enabled billing env + a fake Stripe client that records calls. */
function enableBilling(customerId: string | null) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePriceIds.mockReturnValue({ base: "price_base", overage: "price_overage" });
  env.getStripeSecretKey.mockResolvedValue("sk_test_x");
  db.withTenantDb.mockResolvedValue(customerId); // short-circuits withTenant(readBillingCustomerId)
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
    expect(await startCheckout("org-1", "a@b.test")).toEqual({ status: "disabled" });
    expect(stripe.makeStripeClient).not.toHaveBeenCalled();
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("is disabled when the Stripe key is not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePriceIds.mockReturnValue({ base: "price_base", overage: "price_overage" });
    env.getStripeSecretKey.mockResolvedValue(null);
    expect(await startCheckout("org-1")).toEqual({ status: "disabled" });
  });

  it("is disabled when the price ids are not configured", async () => {
    env.getBillingMode.mockReturnValue("test");
    env.getStripePriceIds.mockReturnValue(null);
    env.getStripeSecretKey.mockResolvedValue("sk_test_x");
    expect(await startCheckout("org-1")).toEqual({ status: "disabled" });
  });

  it("for a NEW org (no customer) creates a session with the email prefilled", async () => {
    const client = enableBilling(null);
    const res = await startCheckout("org-7", "new@x.test");
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

  it("for a returning org reuses the existing Stripe customer", async () => {
    const client = enableBilling("cus_existing");
    await startCheckout("org-7", "ignored@x.test");
    const args = client.createCheckoutSession.mock.calls[0][0];
    expect(args.customer).toBe("cus_existing");
    expect(args.customerEmail).toBeUndefined();
  });

  it("maps a Stripe failure to 'error' (never throws)", async () => {
    const client = enableBilling(null);
    client.createCheckoutSession.mockRejectedValue(new Error("stripe down"));
    expect(await startCheckout("org-7", "a@b.test")).toEqual({ status: "error" });
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
