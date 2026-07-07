import { describe, expect, it } from "vitest";

import {
  makeStripeClient,
  stripeFormEncode,
  StripeError,
  STRIPE_API_VERSION,
} from "./stripe-client";

describe("stripeFormEncode", () => {
  it("encodes scalars and nested objects in bracket notation", () => {
    const s = stripeFormEncode({ mode: "subscription", metadata: { org_id: "org-1" } });
    const p = new URLSearchParams(s);
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("metadata[org_id]")).toBe("org-1");
  });

  it("encodes arrays and arrays-of-objects with indices", () => {
    const s = stripeFormEncode({
      line_items: [{ price: "price_base", quantity: 1 }, { price: "price_overage" }],
    });
    const p = new URLSearchParams(s);
    expect(p.get("line_items[0][price]")).toBe("price_base");
    expect(p.get("line_items[0][quantity]")).toBe("1");
    expect(p.get("line_items[1][price]")).toBe("price_overage");
    expect(p.get("line_items[1][quantity]")).toBeNull(); // omitted
  });

  it("DROPS undefined/null (an absent key is unset, never the literal 'null')", () => {
    const s = stripeFormEncode({ a: "x", b: undefined, c: null, meta: { d: null } });
    const p = new URLSearchParams(s);
    expect(p.get("a")).toBe("x");
    expect(s).not.toMatch(/null|undefined/);
    expect(p.has("b")).toBe(false);
    expect(p.has("meta[d]")).toBe(false);
  });

  it("stringifies booleans and numbers", () => {
    const p = new URLSearchParams(stripeFormEncode({ n: 42, flag: true }));
    expect(p.get("n")).toBe("42");
    expect(p.get("flag")).toBe("true");
  });
});

/** A fake fetch that records the last request and returns a canned response. */
function fakeFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SECRET = "sk_test_do_not_log_me";

describe("makeStripeClient.request", () => {
  it("POSTs form-encoded to /v1<path> with Bearer auth, version, and idempotency key", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: "obj_1" } });
    const client = makeStripeClient({
      secretKey: SECRET,
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });
    const out = await client.request("/customers", { email: "a@b.test" }, "idem-1");
    expect(out).toEqual({ id: "obj_1" });

    const { url, init } = calls[0];
    expect(url).toBe("https://stripe.test/v1/customers");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${SECRET}`);
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(h["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(h["Idempotency-Key"]).toBe("idem-1");
    expect(new URLSearchParams(init.body as string).get("email")).toBe("a@b.test");
  });

  it("omits the Idempotency-Key header when none is given", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: {} });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    await client.request("/x", {});
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("throws a StripeError (status + type) on a non-2xx, never leaking the secret", async () => {
    const { impl } = fakeFetch({
      status: 402,
      body: {
        error: { message: "Your card was declined.", type: "card_error", code: "card_declined" },
      },
    });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    const err = await client.request("/charges", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err.status).toBe(402);
    expect(err.stripeType).toBe("card_error");
    expect(err.stripeCode).toBe("card_declined");
    expect(err.message).toBe("Your card was declined.");
    expect(JSON.stringify(err)).not.toContain(SECRET); // the secret never rides an error
  });

  it("throws a StripeError on a non-JSON gateway error (e.g. a 502 HTML page)", async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    const err = await client.request("/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err.status).toBe(502);
  });
});

describe("makeStripeClient hosted flows", () => {
  it("createCustomer stamps metadata[org_id] + an org-scoped idempotency key", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: "cus_1" } });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    const out = await client.createCustomer({ orgId: "org-9", email: "o@x.test" });
    expect(out.id).toBe("cus_1");
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.get("metadata[org_id]")).toBe("org-9");
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "customer:org-9",
    );
  });

  it("createCheckoutSession sends subscription mode, line items, and the org id on client_ref + sub metadata", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { id: "cs_1", url: "https://checkout" },
    });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    const out = await client.createCheckoutSession({
      customer: "cus_1",
      lineItems: [{ price: "price_base", quantity: 1 }, { price: "price_overage" }],
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      orgId: "org-7",
    });
    expect(out).toEqual({ id: "cs_1", url: "https://checkout" });
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("customer")).toBe("cus_1");
    expect(p.get("client_reference_id")).toBe("org-7");
    expect(p.get("subscription_data[metadata][org_id]")).toBe("org-7");
    expect(p.get("line_items[0][price]")).toBe("price_base");
    expect(p.get("line_items[1][price]")).toBe("price_overage");
    // No idempotency key by default (a Checkout Session charges nothing until completed; a permanent
    // org-scoped key would return a stale session on a legit re-checkout — it's caller-supplied per attempt).
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("forwards a caller-supplied idempotency key on Checkout (collapse a double-submit)", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { id: "cs_2", url: "https://checkout" },
    });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    await client.createCheckoutSession({
      customer: "cus_1",
      lineItems: [{ price: "price_base", quantity: 1 }],
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      orgId: "org-7",
      idempotencyKey: "checkout-attempt-abc",
    });
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "checkout-attempt-abc",
    );
  });

  it("createPortalSession sends the customer + return_url", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: "ps_1", url: "https://portal" } });
    const client = makeStripeClient({ secretKey: SECRET, fetchImpl: impl });
    const out = await client.createPortalSession({
      customer: "cus_1",
      returnUrl: "https://app/back",
    });
    expect(out.url).toBe("https://portal");
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.get("customer")).toBe("cus_1");
    expect(p.get("return_url")).toBe("https://app/back");
  });
});
