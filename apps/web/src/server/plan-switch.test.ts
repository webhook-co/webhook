import { afterEach, describe, expect, it, vi } from "vitest";

// switchPlan orchestration: gate owner/admin + validate the target/live-sub, then remap the sub's items and
// call Stripe with immediate proration. Drive it with fakes and assert the gating + that Stripe is called
// only on a valid switch. Uses the REAL shared pure helpers (isSelfServePlan/planIdForBasePrice/
// planSwitchItems/isBillingActive) — only the env/db/Stripe seams are faked.

const env = vi.hoisted(() => ({
  getBillingMode: vi.fn().mockReturnValue("test"),
  getStripePlans: vi.fn(),
  getAuditChainKey: vi.fn().mockResolvedValue("YWJj"),
}));
vi.mock("./env", () => env);

const billing = vi.hoisted(() => ({ stripeClientFromEnv: vi.fn() }));
vi.mock("./billing", () => billing);

const db = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("./db", () => db);

const log = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => log);

// db seams reached only inside the (mocked) withTenantDb callback → never actually invoked; mock so the
// module imports cleanly without loading node-pg.
vi.mock("@webhook-co/db/client", () => ({ withTenant: vi.fn() }));
vi.mock("@webhook-co/db/reads", () => ({ readActiveSubscription: vi.fn() }));
vi.mock("@webhook-co/db/audit-append", () => ({ appendAuditEntry: vi.fn() }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: vi.fn().mockResolvedValue({}) }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: vi.fn(() => new Uint8Array()) }));

import { switchPlan } from "./plan-switch";

const PLANS = {
  pro: { base: "price_base", overage: "price_overage" },
  scale: { base: "price_scale_base", overage: "price_scale_overage" },
};

/** A fake Stripe client + the role/sub the tenant read returns. */
function enable(opts: {
  role?: string | null;
  sub?: { subscriptionId: string; plan: string; status: string } | null;
  items?: Array<{ id: string; price: string }>;
}) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue(PLANS);
  db.withTenantDb.mockResolvedValue({
    role: opts.role === undefined ? "owner" : opts.role,
    sub:
      opts.sub === undefined
        ? { subscriptionId: "sub_1", plan: "price_base", status: "active" }
        : opts.sub,
  });
  const client = {
    retrieveSubscription: vi.fn().mockResolvedValue({
      id: "sub_1",
      status: "active",
      items: opts.items ?? [
        { id: "si_base", price: "price_base" },
        { id: "si_over", price: "price_overage" },
      ],
    }),
    updateSubscription: vi.fn().mockResolvedValue({ id: "sub_1", status: "active", items: [] }),
  };
  billing.stripeClientFromEnv.mockResolvedValue(client);
  return client;
}

afterEach(() => vi.clearAllMocks());

describe("switchPlan", () => {
  it("switches an active Pro sub to Scale with immediate proration", async () => {
    const client = enable({}); // owner, active on pro
    const res = await switchPlan("org-1", "user-1", "scale");
    expect(res).toEqual({ status: "ok", plan: "scale" });
    const args = client.updateSubscription.mock.calls[0][0];
    expect(args.subscriptionId).toBe("sub_1");
    expect(args.prorationBehavior).toBe("create_prorations");
    expect(args.items).toEqual([
      { id: "si_base", price: "price_scale_base" },
      { id: "si_over", price: "price_scale_overage" },
    ]);
  });

  it("is disabled when BILLING_MODE is off (no Stripe)", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "disabled" });
  });

  it("rejects a non-self-serve / unknown target BEFORE any read or Stripe call", async () => {
    enable({});
    expect(await switchPlan("org-1", "user-1", "enterprise")).toEqual({ status: "unknown_plan" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("forbids a plain member — no Stripe call", async () => {
    const client = enable({ role: "member" });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "forbidden" });
    expect(client.retrieveSubscription).not.toHaveBeenCalled();
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("no_subscription when the org has no sub", async () => {
    const client = enable({ sub: null });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("no_subscription when the sub isn't live (canceled → resubscribe via Checkout instead)", async () => {
    const client = enable({
      sub: { subscriptionId: "sub_1", plan: "price_base", status: "canceled" },
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("same_plan when the target equals the current plan — no Stripe write", async () => {
    const client = enable({}); // on pro
    expect(await switchPlan("org-1", "user-1", "pro")).toEqual({ status: "same_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("unknown_plan when the sub isn't cleanly on its plan's prices (legacy) — refuses to guess", async () => {
    const client = enable({
      items: [
        { id: "si_x", price: "price_legacy_base" },
        { id: "si_y", price: "price_legacy_over" },
      ],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("maps a Stripe failure to 'error' (never throws)", async () => {
    const client = enable({});
    client.updateSubscription.mockRejectedValue(new Error("stripe down"));
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "error" });
  });
});
