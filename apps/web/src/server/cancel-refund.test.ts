import { beforeEach, describe, expect, it, vi } from "vitest";

// Cancel-with-usage-refund (data-lifecycle slice 2.4). The seams (env / db / Stripe) are faked; the REAL pure
// helpers from @webhook-co/shared (baseFeeRefundMinorUnits, isBillingActive…) run unmocked, so the money
// arithmetic under test is the arithmetic that ships.
//
// Several tests below exist because a security review found the original implementation would move WRONG
// money in production. Each is labelled with the bug it locks shut. They are the point of this file.

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

/** A Stripe fake covering every call the flow makes. Defaults = a healthy Pro sub, €19 base paid, 50% used. */
function fakeStripe(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    retrieveSubscription: vi.fn(async () => {
      calls.push("retrieve");
      return {
        id: "sub_1",
        status: "active",
        latestInvoiceId: "in_current",
        items: [
          { id: "si_1", price: "price_base_pro" },
          { id: "si_2", price: "price_over_pro" },
        ],
      };
    }),
    retrieveInvoice: vi.fn(async () => {
      calls.push("invoice");
      return {
        id: "in_current",
        status: "paid",
        charge: "ch_1",
        paymentIntent: "pi_1",
        currency: "eur",
        amountPaidMinorUnits: 1900,
        lines: [
          { priceId: "price_base_pro", amountMinorUnits: 1900, discountMinorUnits: 0 },
          { priceId: "price_over_pro", amountMinorUnits: 0, discountMinorUnits: 0 },
        ],
      };
    }),
    retrievePrice: vi.fn(async () => {
      calls.push("price");
      return { id: "price_base_pro", eventCap: 500_000 };
    }),
    retrieveCharge: vi.fn(async () => {
      calls.push("charge");
      return { amountMinorUnits: 1900, amountRefundedMinorUnits: 0 };
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

/** Set the events consumed in the CURRENT period. */
async function setConsumed(events: number) {
  const reads = await import("@webhook-co/db/reads");
  vi.mocked(reads.readUsageSummary).mockResolvedValue({ events } as never);
}

let role = "owner";

beforeEach(async () => {
  vi.clearAllMocks();
  role = "owner";
  env.getBillingMode.mockReturnValue("test");
  env.getStripePlans.mockReturnValue(PLANS);
  env.getAuditChainKey.mockResolvedValue("YWJj");

  db.withTenantDb.mockImplementation(async (cb: (app: unknown) => Promise<unknown>) => cb({}));
  const client = await import("@webhook-co/db/client");
  vi.mocked(client.withTenant).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (_app: unknown, _org: string, cb: (tx: any) => unknown) =>
      cb(async () => [{ role }])) as never,
  );
  const reads = await import("@webhook-co/db/reads");
  vi.mocked(reads.readActiveSubscription).mockResolvedValue({
    subscriptionId: "sub_1",
    plan: "price_base_pro",
    status: "active",
  });
  await setConsumed(250_000); // half of Pro's 500k
});

describe("cancelSubscriptionWithRefund — the happy path", () => {
  it("cancels and refunds the UNUSED proportion of the base fee (half consumed → half back)", async () => {
    const { client, calls } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 950, currency: "eur" });
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amountMinorUnits: 950 }),
    );
    // Money ordering: cancel BEFORE the refund. A failed refund leaves a retriable debt; a failed cancel
    // would leave us still CHARGING someone we'd already paid back.
    expect(calls.indexOf("cancel")).toBeLessThan(calls.indexOf("refund"));
  });

  it("derives the refund idempotency key from the INVOICE, so an independent retry can't double-refund", async () => {
    const first = fakeStripe();
    await cancelSubscriptionWithRefund(ORG, USER);
    const key = first.client.createRefund.mock.calls[0]![0].idempotencyKey as string;
    expect(key).toContain("in_current");

    vi.clearAllMocks();
    await setConsumed(250_000);
    const second = fakeStripe();
    await cancelSubscriptionWithRefund(ORG, USER);
    expect(second.client.createRefund.mock.calls[0]![0].idempotencyKey).toBe(key);
  });

  it("cancels but refunds NOTHING when the customer consumed their whole included volume", async () => {
    await setConsumed(500_000);
    const { client } = fakeStripe();

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 0, currency: "eur" });
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled();
  });
});

// ── The four money bugs a security review found in the first implementation ─────────────────────────────────

describe("cancelSubscriptionWithRefund — anchors to THIS period's invoice", () => {
  it("BUG 1: a past_due cancel refunds NOTHING — it must not pay out a previous, fully-consumed period", async () => {
    // The customer burned all 500k events in June, their July renewal charge FAILED (past_due, so the
    // current-period invoice is `open`, not paid), and now they cancel with ~0 events used in July.
    // Searching for the latest *paid* invoice would find JUNE's — fully consumed, fully paid — and the
    // ~0 July consumption would compute a ~100% refund of it. Money out of nothing.
    // Anchoring to the subscription's CURRENT invoice (unpaid) means there is nothing prepaid to return.
    await setConsumed(0); // ~0 consumed in the new (unpaid) period
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({
        id: "sub_1",
        status: "past_due",
        latestInvoiceId: "in_july_unpaid",
        items: [{ id: "si_1", price: "price_base_pro" }],
      })),
      retrieveInvoice: vi.fn(async () => ({
        id: "in_july_unpaid",
        status: "open", // the renewal was never paid
        charge: null,
        paymentIntent: null,
        currency: "eur",
        amountPaidMinorUnits: 0,
        lines: [{ priceId: "price_base_pro", amountMinorUnits: 1900, discountMinorUnits: 0 }],
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 0, currency: "eur" });
    expect(client.cancelSubscription).toHaveBeenCalledOnce(); // they still get cancelled
    expect(client.createRefund).not.toHaveBeenCalled(); // but NOT a cent moves
  });

  it("cancels with no refund when the subscription never produced an invoice at all", async () => {
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({
        id: "sub_1",
        status: "trialing",
        latestInvoiceId: null,
        items: [{ id: "si_1", price: "price_base_pro" }],
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 0, currency: null });
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled();
  });
});

describe("cancelSubscriptionWithRefund — a mid-cycle plan switch", () => {
  it("BUG 4: refunds against the plan the INVOICE bought, not the plan the sub currently holds", async () => {
    // WS4 shipped mid-cycle plan switching with `create_prorations`, which issues NO new invoice — so after
    // a Pro→Scale switch the live items hold price_base_scale while the PAID invoice still holds
    // price_base_pro. Deriving the base price from live items finds no matching line → a silent €0 refund
    // for every customer who ever used plan-switch, under a banner promising their money back.
    await setConsumed(100_000); // 100k of PRO's 500k included → 80% unused
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({
        id: "sub_1",
        status: "active",
        latestInvoiceId: "in_current",
        items: [
          { id: "si_1", price: "price_base_scale" }, // switched to Scale
          { id: "si_2", price: "price_over_scale" },
        ],
      })),
      // ...but the money that was actually taken was PRO's base fee.
      retrievePrice: vi.fn(async (priceId: string) => {
        expect(priceId).toBe("price_base_pro"); // the cap must come from the plan they PAID for
        return { id: "price_base_pro", eventCap: 500_000 };
      }),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    // 1900 × (1 − 100k/500k) = 1520 — computed against Pro's base and Pro's included volume.
    expect(result).toEqual({ status: "ok", refundMinorUnits: 1520, currency: "eur" });
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinorUnits: 1520 }),
    );
  });

  it("SUMS every base line rather than taking the first (a proration invoice carries several, incl. negatives)", async () => {
    await setConsumed(0); // nothing used → the whole net base comes back
    const { client } = fakeStripe({
      retrieveInvoice: vi.fn(async () => ({
        id: "in_current",
        status: "paid",
        charge: "ch_1",
        paymentIntent: "pi_1",
        currency: "eur",
        amountPaidMinorUnits: 1400,
        lines: [
          // Stripe proration lines DO carry a price. A `.find()` would bind to whichever came first —
          // possibly the negative credit — and refund a nonsense amount.
          { priceId: "price_base_pro", amountMinorUnits: 1900, discountMinorUnits: 0 },
          { priceId: "price_base_pro", amountMinorUnits: -500, discountMinorUnits: 0 },
        ],
      })),
      retrieveCharge: vi.fn(async () => ({
        amountMinorUnits: 1400,
        amountRefundedMinorUnits: 0,
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "ok", refundMinorUnits: 1400, currency: "eur" }); // 1900 − 500
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinorUnits: 1400 }),
    );
  });
});

describe("cancelSubscriptionWithRefund — never refunds more than was actually captured", () => {
  it("BUG 2: nets a COUPON off the base line (invoice `amount` is pre-discount → would over-refund)", async () => {
    // 50%-off coupon: the base line still reads 1900, but only 950 was ever taken. Refunding a proportion
    // of 1900 can exceed the charge — Stripe rejects it, or (at a smaller ratio) silently over-refunds.
    await setConsumed(0); // nothing used → refund everything that was actually paid
    const { client } = fakeStripe({
      retrieveInvoice: vi.fn(async () => ({
        id: "in_current",
        status: "paid",
        charge: "ch_1",
        paymentIntent: "pi_1",
        currency: "eur",
        amountPaidMinorUnits: 950,
        lines: [
          { priceId: "price_base_pro", amountMinorUnits: 1900, discountMinorUnits: 950 },
          { priceId: "price_over_pro", amountMinorUnits: 0, discountMinorUnits: 0 },
        ],
      })),
      retrieveCharge: vi.fn(async () => ({ amountMinorUnits: 950, amountRefundedMinorUnits: 0 })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.refundMinorUnits).toBe(950); // the net base, NOT 1900
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinorUnits: 950 }),
    );
  });

  it("BUG 7: clamps to the charge's REMAINING headroom when part of it was already refunded", async () => {
    // Support (or the Portal) already refunded 1500 of the 1900 charge. We may only return the other 400.
    await setConsumed(0); // would otherwise compute a full 1900 refund
    const { client } = fakeStripe({
      retrieveCharge: vi.fn(async () => ({
        amountMinorUnits: 1900,
        amountRefundedMinorUnits: 1500,
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.refundMinorUnits).toBe(400);
    expect(client.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinorUnits: 400 }),
    );
  });

  it("refunds nothing when the charge is already FULLY refunded (no zero/negative refund is ever sent)", async () => {
    await setConsumed(0);
    const { client } = fakeStripe({
      retrieveCharge: vi.fn(async () => ({
        amountMinorUnits: 1900,
        amountRefundedMinorUnits: 1900,
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.refundMinorUnits).toBe(0);
    expect(client.createRefund).not.toHaveBeenCalled();
  });
});

describe("cancelSubscriptionWithRefund — never claims a refund it didn't make", () => {
  it("BUG 3: a credit-settled invoice (no charge) reports refund_unavailable, NOT ok", async () => {
    // Money was 'paid' but settled from customer balance/credit, so there is no charge to reverse. Reporting
    // `ok` here would tell the user their money is on its way back AND write a signed audit record of a
    // refund that never happened — worse than saying nothing.
    await setConsumed(250_000);
    const { client } = fakeStripe({
      retrieveInvoice: vi.fn(async () => ({
        id: "in_current",
        status: "paid",
        charge: null, // settled from credit
        paymentIntent: null,
        currency: "eur",
        amountPaidMinorUnits: 1900,
        lines: [{ priceId: "price_base_pro", amountMinorUnits: 1900, discountMinorUnits: 0 }],
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result).toEqual({ status: "refund_unavailable", refundMinorUnits: 950 });
    expect(client.cancelSubscription).toHaveBeenCalledOnce(); // the cancel still stands
    expect(client.createRefund).not.toHaveBeenCalled();
  });

  it("reports refund_unavailable when money was paid but NO base line is recognisable (legacy price)", async () => {
    // A sub on an archived/legacy base price we can't map. Silently refunding 0 under an 'ok' banner is the
    // same lie as bug 4 — surface it so a human can look.
    const { client } = fakeStripe({
      retrieveInvoice: vi.fn(async () => ({
        id: "in_current",
        status: "paid",
        charge: "ch_1",
        paymentIntent: "pi_1",
        currency: "eur",
        amountPaidMinorUnits: 1900,
        lines: [{ priceId: "price_legacy_v1", amountMinorUnits: 1900, discountMinorUnits: 0 }],
      })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.status).toBe("refund_unavailable");
    expect(client.cancelSubscription).toHaveBeenCalledOnce();
    expect(client.createRefund).not.toHaveBeenCalled();
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.cancel_base_line_unresolved",
      expect.any(Error),
    );
  });

  it("reports refund_failed (NOT error) when the cancel succeeded but the refund call threw", async () => {
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

  it("refunds NOTHING when the plan is unlimited (eventCap null → no denominator)", async () => {
    const { client } = fakeStripe({
      retrievePrice: vi.fn(async () => ({ id: "price_base_pro", eventCap: null })),
    });

    const result = await cancelSubscriptionWithRefund(ORG, USER);

    expect(result.refundMinorUnits).toBe(0);
    expect(client.createRefund).not.toHaveBeenCalled();
  });
});

describe("cancelSubscriptionWithRefund — gates", () => {
  it("is DISABLED when BILLING_MODE is off — no Stripe client is even built", async () => {
    env.getBillingMode.mockReturnValue("off");
    const { client } = fakeStripe();
    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "disabled" });
    expect(billing.stripeClientFromEnv).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it("is DISABLED when the Stripe key isn't configured", async () => {
    fakeStripe();
    billing.stripeClientFromEnv.mockResolvedValue(null);
    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "disabled" });
  });

  it("FORBIDS a non-owner/admin from cancelling — and never reaches Stripe", async () => {
    role = "member";
    const { client } = fakeStripe();

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "forbidden" });
    expect(client.retrieveSubscription).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it("returns no_subscription when the org has none", async () => {
    const reads = await import("@webhook-co/db/reads");
    vi.mocked(reads.readActiveSubscription).mockResolvedValue(null);
    const { client } = fakeStripe();

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "no_subscription" });
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it("returns no_subscription when Stripe already shows it canceled (a lagged mirror)", async () => {
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({
        id: "sub_1",
        status: "canceled",
        latestInvoiceId: "in_current",
        items: [],
      })),
    });

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "no_subscription" });
    expect(client.cancelSubscription).not.toHaveBeenCalled(); // don't re-cancel, don't re-refund
  });

  it("NEVER throws — a Stripe failure BEFORE the cancel becomes a clean error, and nothing is cancelled", async () => {
    const { client } = fakeStripe({
      retrieveSubscription: vi.fn(async () => {
        throw new Error("network");
      }),
    });

    expect(await cancelSubscriptionWithRefund(ORG, USER)).toEqual({ status: "error" });
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });
});
