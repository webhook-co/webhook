import { createHmac } from "node:crypto";

import type { SecretsStoreSecret } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the state-sync appliers so dispatchStripeEvent's type→applier routing can be asserted without a
// DB; everything else in @webhook-co/db (parsers, createClient, recordStripeEventOnce) stays real.
const sync = vi.hoisted(() => ({
  applyCustomerLink: vi.fn(),
  applySubscriptionUpsert: vi.fn(),
  applySubscriptionDeleted: vi.fn(),
}));
vi.mock("@webhook-co/db", async (orig) => ({
  ...(await orig<typeof import("@webhook-co/db")>()),
  ...sync,
}));

import {
  applyStripeEvent,
  handleStripeWebhook,
  parseInvoiceForFlush,
  type TailFlushRunner,
  verifyAndParseStripeEvent,
  type StripeEvent,
  type StripeWebhookEnv,
} from "./stripe-webhook";

// The S4.5a Stripe inbound receiver: verify via the audited adapter, then parse + livemode-guard + dedup.
// Signatures are produced exactly as Stripe does — `v1 = HMAC_SHA256(secret, "{t}.{body}")`, hex — so these
// exercise the real adapter, not a stub.

const SECRET = "whsec_test_do_not_log";

/** Build a Stripe `stripe-signature` header value for `body` at timestamp `ts`. */
function stripeSig(body: string, secret: string, ts: number): string {
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

const TS = 1_752_000_000;
const AT = new Date(TS * 1000); // the verification clock (within tolerance of TS)

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    created: TS,
    livemode: false,
    data: { object: { id: "cs_1" } },
    ...overrides,
  };
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("verifyAndParseStripeEvent", () => {
  it("verifies a well-signed event and returns the parsed envelope", async () => {
    const body = JSON.stringify(event());
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["stripe-signature", stripeSig(body, SECRET, TS)]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.event.id).toBe("evt_1");
      expect(res.event.type).toBe("checkout.session.completed");
      expect(res.event.data.object.id).toBe("cs_1");
    }
  });

  it("is 'unconfigured' when no signing secret is set (can't verify → fail closed)", async () => {
    const body = JSON.stringify(event());
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["stripe-signature", stripeSig(body, SECRET, TS)]],
      signingSecret: null,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("unconfigured");
  });

  it("is 'missing_signature' when the stripe-signature header is absent", async () => {
    const body = JSON.stringify(event());
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["content-type", "application/json"]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("missing_signature");
  });

  it("rejects a WRONG-secret signature (bad_signature, never parses the body)", async () => {
    const body = JSON.stringify(event());
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["stripe-signature", stripeSig(body, "whsec_attacker", TS)]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("bad_signature");
  });

  it("rejects a TAMPERED body (signature was over the original bytes)", async () => {
    const original = JSON.stringify(event());
    const tampered = JSON.stringify(event({ type: "evil.type" }));
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(tampered),
      headers: [["stripe-signature", stripeSig(original, SECRET, TS)]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("bad_signature");
  });

  it("is 'bad_json' when a VALIDLY-signed body isn't a well-formed Stripe event", async () => {
    const notJson = "this is signed but not json";
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(notJson),
      headers: [["stripe-signature", stripeSig(notJson, SECRET, TS)]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("bad_json");
  });

  it("is 'bad_json' when the JSON is missing required event fields", async () => {
    const body = JSON.stringify({ id: "evt_x", type: "t" }); // no created/livemode/data
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["stripe-signature", stripeSig(body, SECRET, TS)]],
      signingSecret: SECRET,
      billingLive: false,
      now: AT,
    });
    expect(res.kind).toBe("bad_json");
  });

  it("rejects a livemode mismatch — a test event must never drive live state", async () => {
    const body = JSON.stringify(event({ livemode: false }));
    const res = await verifyAndParseStripeEvent({
      rawBody: bytes(body),
      headers: [["stripe-signature", stripeSig(body, SECRET, TS)]],
      signingSecret: SECRET,
      billingLive: true, // configured LIVE, but the event is a test event
      now: AT,
    });
    expect(res.kind).toBe("livemode_mismatch");
  });
});

describe("parseInvoiceForFlush", () => {
  const base = {
    id: "in_1",
    subscription: "sub_1",
    billing_reason: "subscription_cycle",
    period_start: Date.UTC(2026, 6, 1) / 1000, // 2026-07-01
    period_end: Date.UTC(2026, 6, 31, 8, 0, 0) / 1000, // 2026-07-31T08:00Z (mid-day boundary)
    subscription_details: { metadata: { org_id: "org-a" } },
  };

  it("extracts org, floor (utcDay of period_start), and periodEndMs from a subscription cycle", () => {
    expect(parseInvoiceForFlush(base)).toEqual({
      orgId: "org-a",
      floorDay: "2026-07-01",
      periodEndMs: Date.UTC(2026, 6, 31, 8, 0, 0),
    });
  });

  it("reads the Basil (2025-03-31+) shape: org + subscription under invoice.parent.subscription_details", () => {
    const basil = {
      id: "in_1",
      billing_reason: "subscription_cycle",
      period_start: base.period_start,
      period_end: base.period_end,
      parent: {
        subscription_details: { subscription: "sub_1", metadata: { org_id: "org-basil" } },
      },
    };
    expect(parseInvoiceForFlush(basil)?.orgId).toBe("org-basil");
  });

  it("falls back to lines[0].metadata.org_id when subscription_details has none", () => {
    const inv = {
      ...base,
      subscription_details: {},
      lines: { data: [{ metadata: { org_id: "org-b" } }] },
    };
    expect(parseInvoiceForFlush(inv)?.orgId).toBe("org-b");
  });

  it("is null without an org_id (an invoice we can't attribute is never flushed)", () => {
    expect(parseInvoiceForFlush({ ...base, subscription_details: { metadata: {} } })).toBeNull();
  });

  it("is null for a non-subscription invoice (no subscription id in either shape)", () => {
    expect(parseInvoiceForFlush({ ...base, subscription: null })).toBeNull();
  });

  it("is null for a proration/update invoice — only subscription_cycle renewals flush", () => {
    expect(parseInvoiceForFlush({ ...base, billing_reason: "subscription_update" })).toBeNull();
    expect(parseInvoiceForFlush({ ...base, billing_reason: "subscription_create" })).toBeNull();
  });

  it("is null for the 0-length first invoice (period_end <= period_start)", () => {
    const t = Date.UTC(2026, 6, 1) / 1000;
    expect(parseInvoiceForFlush({ ...base, period_start: t, period_end: t })).toBeNull();
  });
});

/** A Request to the webhook endpoint. Signs at the CURRENT clock (the handler uses the real clock). */
function webhookRequest(body: string, secret = SECRET): Request {
  const ts = Math.floor(Date.now() / 1000);
  return new Request("https://api.test/v1/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": stripeSig(body, secret, ts),
      "content-type": "application/json",
    },
    body,
  });
}

const secretEnv = SECRET as unknown as SecretsStoreSecret; // readSecretBinding accepts a plain string in tests
const testEnv = {
  BILLING_MODE: "test",
  STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv,
} as StripeWebhookEnv;

describe("handleStripeWebhook", () => {
  it("is dark (503) when BILLING_MODE is off/unset — no body read, no process", async () => {
    const process = vi.fn();
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event())),
      { BILLING_MODE: "off", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      { process },
    );
    expect(res.status).toBe(503);
    expect(process).not.toHaveBeenCalled();
  });

  it("ACKs 200 after PROCESSING a verified event", async () => {
    const process = vi.fn().mockResolvedValue("applied");
    const res = await handleStripeWebhook(webhookRequest(JSON.stringify(event())), testEnv, {
      process,
    });
    expect(res.status).toBe(200);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ id: "evt_1" }));
  });

  it("ACKs 200 on a REPLAY (process short-circuits)", async () => {
    const res = await handleStripeWebhook(webhookRequest(JSON.stringify(event())), testEnv, {
      process: vi.fn().mockResolvedValue("replay"),
    });
    expect(res.status).toBe(200);
  });

  it("returns 500 when processing FAILS, so Stripe redelivers (nothing lost)", async () => {
    const res = await handleStripeWebhook(webhookRequest(JSON.stringify(event())), testEnv, {
      process: vi.fn().mockRejectedValue(new Error("db down")),
    });
    expect(res.status).toBe(500);
  });

  it("returns 400 for an invalid signature (wrong secret) — never processes", async () => {
    const process = vi.fn();
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event()), "whsec_attacker"),
      testEnv,
      { process },
    );
    expect(res.status).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });

  it("returns 503 when the billing Hyperdrive isn't provisioned (verified but can't process → fail closed)", async () => {
    const res = await handleStripeWebhook(webhookRequest(JSON.stringify(event())), testEnv);
    expect(res.status).toBe(503);
  });

  it("returns 413 for an oversized body", async () => {
    const huge = "x".repeat(512 * 1024 + 10);
    const res = await handleStripeWebhook(
      new Request("https://api.test/v1/stripe/webhook", { method: "POST", body: huge }),
      testEnv,
      { process: vi.fn() },
    );
    expect(res.status).toBe(413);
  });
});

describe("applyStripeEvent — routes each event type to its applier", () => {
  afterEach(() => vi.clearAllMocks());
  const billing = {} as never; // the appliers are mocked; the connection is never touched
  const ev = (type: string, object: Record<string, unknown>): StripeEvent => ({
    id: "evt",
    type,
    created: 9000,
    livemode: false,
    data: { object },
  });

  it("checkout.session.completed → applyCustomerLink(org, customer)", async () => {
    await applyStripeEvent(
      billing,
      ev("checkout.session.completed", { client_reference_id: "org-a", customer: "cus_1" }),
    );
    expect(sync.applyCustomerLink).toHaveBeenCalledWith(billing, {
      orgId: "org-a",
      customerId: "cus_1",
    });
  });

  it("customer.subscription.updated → applySubscriptionUpsert with the event.created watermark", async () => {
    const obj = {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { org_id: "org-a" },
      current_period_start: 1000,
      current_period_end: 2000,
      items: { data: [{ price: { id: "price_pro", metadata: { event_cap: "500000" } } }] },
    };
    await applyStripeEvent(billing, ev("customer.subscription.updated", obj));
    expect(sync.applySubscriptionUpsert).toHaveBeenCalledWith(
      billing,
      expect.objectContaining({ orgId: "org-a", eventCap: 500000 }),
      9000,
    );
  });

  it("customer.subscription.deleted → applySubscriptionDeleted(org, created)", async () => {
    await applyStripeEvent(
      billing,
      ev("customer.subscription.deleted", { metadata: { org_id: "org-a" } }),
    );
    expect(sync.applySubscriptionDeleted).toHaveBeenCalledWith(billing, {
      orgId: "org-a",
      eventCreated: 9000,
    });
  });

  it("an unhandled type (invoice.paid) is a no-op — no applier called", async () => {
    await applyStripeEvent(billing, ev("invoice.paid", { id: "in_1" }));
    expect(sync.applyCustomerLink).not.toHaveBeenCalled();
    expect(sync.applySubscriptionUpsert).not.toHaveBeenCalled();
    expect(sync.applySubscriptionDeleted).not.toHaveBeenCalled();
  });

  it("invoice.created → runs the flush; 'applied' (dedup) only when it reports fully handled", async () => {
    const onInvoiceCreated = vi.fn().mockResolvedValue(true);
    const flush: TailFlushRunner = { onInvoiceCreated };
    const invoice = { id: "in_1", subscription: "sub_1", period_start: 100, period_end: 200 };
    expect(await applyStripeEvent(billing, ev("invoice.created", invoice), flush)).toBe("applied");
    expect(onInvoiceCreated).toHaveBeenCalledWith(invoice);
  });

  it("invoice.created is 'rejected' (NOT deduped) when the flush reports a residual — stays replayable", async () => {
    const flush: TailFlushRunner = { onInvoiceCreated: vi.fn().mockResolvedValue(false) };
    expect(await applyStripeEvent(billing, ev("invoice.created", { id: "in_1" }), flush)).toBe(
      "rejected",
    );
  });

  it("invoice.created is 'rejected' (NOT deduped) when the flush is dark — replayable once provisioned", async () => {
    // ACK 200 but never write the dedup marker, so a later replay reprocesses instead of silently dropping.
    expect(await applyStripeEvent(billing, ev("invoice.created", { id: "in_1" }))).toBe("rejected");
  });

  it("does NOT run the flush for a non-created invoice event (only invoice.created)", async () => {
    const onInvoiceCreated = vi.fn();
    await applyStripeEvent(billing, ev("invoice.paid", { id: "in_1" }), { onInvoiceCreated });
    expect(onInvoiceCreated).not.toHaveBeenCalled();
  });

  it("PROPAGATES an applier error (→ handler 500 → Stripe redelivers; never silently swallowed)", async () => {
    sync.applyCustomerLink.mockRejectedValueOnce(new Error("db down"));
    await expect(
      applyStripeEvent(
        billing,
        ev("checkout.session.completed", { client_reference_id: "org-a", customer: "cus_1" }),
      ),
    ).rejects.toThrow("db down");
  });

  it("returns 'rejected' on a customer_mismatch (so processStripeEvent won't dedup it)", async () => {
    sync.applySubscriptionUpsert.mockResolvedValueOnce("customer_mismatch");
    const obj = {
      id: "sub_1",
      customer: "cus_wrong",
      status: "active",
      metadata: { org_id: "org-a" },
      current_period_start: 1000,
      current_period_end: 2000,
      items: { data: [{ price: { id: "p", metadata: { event_cap: "1" } } }] },
    };
    expect(await applyStripeEvent(billing, ev("customer.subscription.updated", obj))).toBe(
      "rejected",
    );
  });

  it("returns 'applied' for a normal subscription + an unhandled type", async () => {
    sync.applySubscriptionUpsert.mockResolvedValueOnce("applied");
    const obj = {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { org_id: "org-a" },
      current_period_start: 1000,
      current_period_end: 2000,
      items: { data: [{ price: { id: "p", metadata: { event_cap: "1" } } }] },
    };
    expect(await applyStripeEvent(billing, ev("customer.subscription.updated", obj))).toBe(
      "applied",
    );
    expect(await applyStripeEvent(billing, ev("invoice.paid", { id: "in_1" }))).toBe("applied");
  });
});
