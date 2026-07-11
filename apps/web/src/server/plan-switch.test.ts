import { afterEach, describe, expect, it, vi } from "vitest";

// switchPlan orchestration: gate owner/admin (BEFORE resolving the Stripe secret), then derive the CURRENT
// plan from LIVE Stripe state (retrieveSubscription) and remap the sub's items with immediate proration.
// Uses the REAL shared pure helpers (isSelfServePlan/planIdForBasePrice/planSwitchItems/isBillingActive/
// isBillingManagerRole) — only the env/db/Stripe seams are faked.

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
const PRO_ITEMS = [
  { id: "si_base", price: "price_base" },
  { id: "si_over", price: "price_overage" },
];

/** Configure the role/sub the tenant read returns + the LIVE Stripe sub retrieveSubscription returns. */
function enable(opts: {
  role?: string | null;
  hasSub?: boolean; // the mirror row exists (controls the pre-retrieve no_subscription check)
  liveStatus?: string;
  liveItems?: Array<{ id: string; price: string }>;
}) {
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue(PLANS);
  db.withTenantDb.mockResolvedValue({
    role: opts.role === undefined ? "owner" : opts.role,
    sub:
      opts.hasSub === false
        ? null
        : { subscriptionId: "sub_1", plan: "price_base", status: "active" },
  });
  const client = {
    retrieveSubscription: vi.fn().mockResolvedValue({
      id: "sub_1",
      status: opts.liveStatus ?? "active",
      items: opts.liveItems ?? PRO_ITEMS,
    }),
    updateSubscription: vi.fn().mockResolvedValue({ id: "sub_1", status: "active", items: [] }),
  };
  billing.stripeClientFromEnv.mockResolvedValue(client);
  return client;
}

afterEach(() => vi.clearAllMocks());

describe("switchPlan", () => {
  it("switches an active Pro sub to Scale with immediate proration (current plan from LIVE items)", async () => {
    const client = enable({});
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

  it("forwards the idempotency nonce to the Stripe write (collapses a double-submit)", async () => {
    const client = enable({});
    await switchPlan("org-1", "user-1", "scale", "nonce-1");
    expect(client.updateSubscription.mock.calls[0][0].idempotencyKey).toBe("nonce-1");
  });

  it("is disabled when BILLING_MODE is off (no read, no Stripe)", async () => {
    env.getBillingMode.mockReturnValue("off");
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "disabled" });
  });

  it("rejects a non-self-serve / unknown target BEFORE any read or Stripe call", async () => {
    enable({});
    expect(await switchPlan("org-1", "user-1", "enterprise")).toEqual({ status: "unknown_plan" });
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("rejects a target THIS deploy has no prices for (partial config) — before any read", async () => {
    enable({});
    env.getStripePlans.mockReturnValue({ pro: PLANS.pro }); // no scale
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(db.withTenantDb).not.toHaveBeenCalled();
  });

  it("forbids a plain member — the gate runs BEFORE the Stripe secret is resolved", async () => {
    enable({ role: "member" });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "forbidden" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("forbids a user with NO membership row (role null) — before the secret", async () => {
    enable({ role: null });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "forbidden" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("no_subscription when the org has no mirror sub row", async () => {
    enable({ hasSub: false });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
  });

  it("no_subscription when the LIVE sub isn't entitled (canceled/unpaid/paused)", async () => {
    for (const status of ["canceled", "unpaid", "paused"]) {
      const client = enable({ liveStatus: status });
      expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "no_subscription" });
      expect(client.updateSubscription).not.toHaveBeenCalled();
    }
  });

  it("same_plan when the LIVE sub is ALREADY on the target — incl. a lagged retry post-switch", async () => {
    const client = enable({
      liveItems: [
        { id: "si_base", price: "price_scale_base" },
        { id: "si_over", price: "price_scale_overage" },
      ],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "same_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("unknown_plan when the LIVE sub is on a legacy/unmapped price", async () => {
    const client = enable({
      liveItems: [
        { id: "si_x", price: "price_legacy_base" },
        { id: "si_y", price: "price_legacy_over" },
      ],
    });
    expect(await switchPlan("org-1", "user-1", "scale")).toEqual({ status: "unknown_plan" });
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it("unknown_plan (refuses) when the LIVE sub carries an EXTRA item — would leave a stray meter", async () => {
    const client = enable({
      liveItems: [...PRO_ITEMS, { id: "si_stray", price: "price_legacy_extra" }],
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
