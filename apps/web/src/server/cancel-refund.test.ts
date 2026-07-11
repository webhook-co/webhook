import { beforeEach, describe, expect, it, vi } from "vitest";

// Cancel-with-usage-refund (data-lifecycle slice 2.4). The seams (env / db / Stripe) are faked; the REAL pure
// helpers from @webhook-co/shared (baseFeeRefundMinorUnits, isBillingActive, planIdForBasePrice…) run
// unmocked, so the money arithmetic under test is the arithmetic that ships.

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
vi.mock("@webhook-co/db/reads", () => ({
  readActiveSubscription: vi.fn(),
  readUsageSummary: vi.fn(),
}));
vi.mock("@webhook-co/db/audit-append", () => ({ appendAuditEntry: vi.fn() }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: vi.fn().mockResolvedValue("key") }));

import { cancelSubscriptionWithRefund } from "./cancel-refund";

const PLANS = {
  pro: { base: "price_base_pro", overage: "price_over_pro" },
  scale: { base: "price_base_scale", overage: "price_over_scale" },
};

const ORG = "org-1";
const USER = "user-1";

/** Wire the tenant-tx gate reads: the caller's role, the org's sub, and its period usage. */
function seedTenant(opts: {
  role?: string | null;
  sub?: { subscriptionId: string; plan: string; status: string; eventCap: number | null } | null;
  consumed?: number;
}) {
  const gate = {
    role: opts.role === undefined ? "owner" : opts.role,
    sub:
      opts.sub === undefined
        ? {
            subscriptionId: "sub_1",
            plan: "price_base_pro",
            status: "active",
            eventCap: 500_000,
          }
        : opts.sub,
    consumed: opts.consumed ?? 0,
  };
  // withTenantDb(cb) → cb(app); the orchestration's callback returns the gate object it assembled.
  db.withTenantDb.mockImplementation(async (cb: (app: unknown) => Promise<unknown>) => cb({}));
  return gate;
}

/** A Stripe client fake covering the four calls the flow makes. */
function fakeStripe(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    retrieveSubscription: vi.fn(async () => {
      calls.push("retrieve");
      return {
        id: "sub_1",
        status: "active",
        items: [
          { id: "si_1", price: "price_base_pro" },
          { id: "si_2", price: "price_over_pro" },
        ],
      };
    }),
    retrieveLatestPaidInvoice: vi.fn(async () => {
      calls.push("invoice");
      return {
        id: "in_1",
        charge: "ch_1",
        paymentIntent: "pi_1",
        currency: "eur",
        lines: [
          { priceId: "price_base_pro", amountMinorUnits: 1900 },
          { priceId: "price_over_pro", amountMinorUnits: 0 },
        ],
      };
    }),
    cancelSubscription: vi.fn(async () => {
      calls.push("cancel");
      return { id: "sub_1", status: "canceled" };
    }),
    createRefund: vi.fn(async () => {
      calls.push("refund");
      return { id: "re_1", status: "succeeded", amountMinorUnits: 950 };
    }),
    ...over,
  };
  billing.stripeClientFromEnv.mockResolvedValue(client);
  return { client, calls };
}

beforeEach(async () => {
  vi.clearAllMocks();
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue(PLANS);
  env.getAuditChainKey.mockResolvedValue("YWJj");

  const reads = await import("@webhook-co/db/reads");
  const client = await import("@webhook-co/db/client");
  // withTenant(app, org, cb) → cb(tx) with a tx whose reads come from the mocked read fns.
  vi.mocked(client.withTenant).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (_app: unknown, _org: string, cb: (tx: any) => unknown) => {
      const tx = Object.assign(
        // the role query is a raw tagged template in the orchestration
        async () => [{ role: (globalThis as never as { __role: string }).__role ?? "owner" }],
        {},
      );
      return cb(tx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
  vi.mocked(reads.readActiveSubscription).mockResolvedValue({
    subscriptionId: "sub_1",
    plan: "price_base_pro",
    status: "active",
    eventCap: 500_000,
  });
  vi.mocked(reads.readUsageSummary).mockResolvedValue({ events: 250_000 } as never);
});

describe("cancelSubscriptionWithRefund", () => {
  it("cancels and refunds the UNUSED proportion of the base fee (half consumed → half back)", async () => {
    seedTenant({});
    const { client, calls } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 950, currency: "eur" });
    // 1900 base × (1 − 250k/500k) = 950.
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amountMinorUnits: 950 }),
    );
    // The money-ordering guarantee: the subscription is CANCELED before we try to move money back. A failed
    // refund leaves us owing a retriable debt; a failed cancel would leave us still CHARGING them.
    expect(calls.indexOf("cancel")).toBeLessThan(calls.indexOf("refund"));
  });

  it("uses a DETERMINISTIC idempotency key so a retried cancel can never refund twice", async () => {
    seedTenant({});
    const { client } = fakeStripe();

    await cancelSubscriptionWithRefund(ORG, USER);

    const key = client.createRefund.mock.calls[0]![0].idempotencyKey as string;
    // Keyed on the INVOICE (the money that was taken), not on a per-click nonce — two independent cancel
    // attempts against the same paid invoice collapse to one refund at Stripe.
    expect(key).toContain("in_1");

    // A second, fully independent attempt derives the SAME key.
    vi.clearAllMocks();
    seedTenant({});
    const second = fakeStripe();
    await cancelSubscriptionWithRefund(ORG, USER);
    expect(second.client.createRefund.mock.calls[0]![0].idempotencyKey).toBe(key);
  });

  it("cancels but refunds NOTHING when the customer consumed their whole included volume", async () => {
    seedTenant({});
    const reads = await import("@webhook-co/db/reads");
    vi.mocked(reads.readUsageSummary).mockResolvedValue({ events: 500_000 } as never);
    const { client } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 0, currency: "eur" });
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled(); // never send a zero-amount refund
  });

  it("cancels with NO refund when the subscription never billed (a trial → no paid invoice)", async () => {
    seedTenant({});
    const { client } = fakeStripe({ retrieveLatestPaidInvoice: vi.fn(async () => null) });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 0, currency: null });
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled();
  });

  it("cancels with NO refund when the paid invoice has no charge to refund against (credit-settled)", async () => {
    seedTenant({});
    const { client } = fakeStripe({
      retrieveLatestPaidInvoice: vi.fn(async () => ({
        id: "in_1",
        charge: null,
        paymentIntent: null,
        currency: "eur",
        lines: [{ priceId: "price_base_pro", amountMinorUnits: 1900 }],
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.status).toBe("ok");
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled();
  });

  it("reports refund_failed (NOT error) when the cancel succeeded but the refund leg threw", async () => {
    // The subscription IS canceled — the UI must say so truthfully and tell them the refund is being chased,
    // never imply the cancellation didn't happen (they'd cancel again).
    seedTenant({});
    const { client } = fakeStripe({
      createRefund: vi.fn(async () => {
        throw new Error("stripe down");
      }),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "refund_failed", refundMinorUnits: 950 });
    expect(client.cancelSubscription).toHaveBeenCalledOnce(); // the cancel STANDS
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.cancel_refund_failed",
      expect.any(Error),
    );
  });

  it("refunds NOTHING on an unlimited plan (no included volume → no usage proportion)", async () => {
    seedTenant({});
    const reads = await import("@webhook-co/db/reads");
    vi.mocked(reads.readActiveSubscription).mockResolvedValue({
      subscriptionId: "sub_1",
      plan: "price_base_pro",
      status: "active",
      eventCap: null,
    });
    const { client } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.refundMinorUnits).toBe(0);
    expect(client.createRefund).not.toHaveBeenCalled();
  });

  it("is DISABLED when BILLING_MODE is off — no Stripe client is even built", async () => {
    env.getBillingMode.mockReturnValue("off");
    const { client } = fakeStripe();

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "disabled" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it("is DISABLED when the Stripe key isn't configured (client is null)", async () => {
    seedTenant({});
    billing.stripeClientFromEnv.mockResolvedValue(null);
    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "disabled" });
  });

  it("FORBIDS a non-owner/admin from canceling — and never reaches Stripe", async () => {
    seedTenant({});
    (globalThis as never as { __role: string }).__role = "member";
    const { client } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "forbidden" });
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    expect(client.createRefund).not.toHaveBeenCalled();
    (globalThis as never as { __role: string }).__role = "owner";
  });

  it("returns no_subscription when the org has none", async () => {
    seedTenant({});
    const reads = await import("@webhook-co/db/reads");
    vi.mocked(reads.readActiveSubscription).mockResolvedValue(null);
    const { client } = fakeStripe();

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "no_subscription" });
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it("returns no_subscription when Stripe says the sub is already canceled (a lagged mirror)", async () => {
    seedTenant({});
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({ id: "sub_1", status: "canceled", items: [] })),
    });

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "no_subscription" });
    expect(client.cancelSubscription).not.toHaveBeenCalled(); // don't re-cancel, don't re-refund
  });

  it("NEVER throws — an unexpected Stripe failure before the cancel becomes a clean error status", async () => {
    seedTenant({});
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => {
        throw new Error("network");
      }),
    });

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "error" });
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });
});
