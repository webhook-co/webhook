import { createHmac } from "node:crypto";

import type { SecretsStoreSecret } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import {
  handleStripeWebhook,
  verifyAndParseStripeEvent,
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

describe("handleStripeWebhook", () => {
  it("is dark (503) when BILLING_MODE is off/unset — no body read, no verify", async () => {
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event())),
      { BILLING_MODE: "off", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      vi.fn(),
    );
    expect(res.status).toBe(503);
  });

  it("ACKs 200 and records a fresh verified event (the dedup insert wins)", async () => {
    const body = JSON.stringify(event());
    const record = vi.fn().mockResolvedValue(true);
    const res = await handleStripeWebhook(
      webhookRequest(body),
      { BILLING_MODE: "test", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      record,
    );
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledWith({
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      eventCreated: TS,
    });
  });

  it("ACKs 200 on a REPLAY (dedup returns false) — no error", async () => {
    const record = vi.fn().mockResolvedValue(false);
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event())),
      { BILLING_MODE: "test", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      record,
    );
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it("returns 400 for an invalid signature (wrong secret) — never records", async () => {
    const record = vi.fn();
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event()), "whsec_attacker"),
      { BILLING_MODE: "test", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      record,
    );
    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("returns 503 when the billing Hyperdrive isn't provisioned (verified but can't dedup → fail closed)", async () => {
    const res = await handleStripeWebhook(
      webhookRequest(JSON.stringify(event())),
      { BILLING_MODE: "test", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      // no injected recordOnce AND no HYPERDRIVE_BILLING → 503 after verify
    );
    expect(res.status).toBe(503);
  });

  it("returns 413 for an oversized body", async () => {
    const huge = "x".repeat(512 * 1024 + 10);
    const res = await handleStripeWebhook(
      new Request("https://api.test/v1/stripe/webhook", { method: "POST", body: huge }),
      { BILLING_MODE: "test", STRIPE_WEBHOOK_SIGNING_SECRET: secretEnv } as StripeWebhookEnv,
      vi.fn(),
    );
    expect(res.status).toBe(413);
  });
});
