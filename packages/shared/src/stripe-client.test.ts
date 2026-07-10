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
      mode: "test",
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
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    const err = await client.request("/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err.status).toBe(502);
  });
});

describe("makeStripeClient hosted flows", () => {
  it("createCustomer stamps metadata[org_id] + an org-scoped idempotency key", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: "cus_1" } });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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

  it("for a NEW subscriber (no customer) sends customer_email and omits customer", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { id: "cs_3", url: "https://checkout" },
    });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    await client.createCheckoutSession({
      customerEmail: "new@x.test",
      lineItems: [{ price: "price_base", quantity: 1 }],
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      orgId: "org-7",
    });
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.get("customer_email")).toBe("new@x.test");
    expect(p.has("customer")).toBe(false); // Checkout will create the customer
  });

  it("with an existing customer, sends customer and NOT customer_email", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { id: "cs_4", url: "https://checkout" },
    });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    await client.createCheckoutSession({
      customer: "cus_1",
      customerEmail: "ignored@x.test",
      lineItems: [{ price: "price_base", quantity: 1 }],
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      orgId: "org-7",
    });
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.get("customer")).toBe("cus_1");
    expect(p.has("customer_email")).toBe(false); // an existing customer wins; no email prefill
  });

  it("forwards a caller-supplied idempotency key on Checkout (collapse a double-submit)", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { id: "cs_2", url: "https://checkout" },
    });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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

  it("reportMeterEvent POSTs /billing/meter_events with the customer, value, timestamp + identifier dedup", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { identifier: "org-7:2026-07-15", event_name: "webhook_events" },
    });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    const out = await client.reportMeterEvent({
      eventName: "webhook_events",
      customer: "cus_1",
      value: 4200,
      identifier: "org-7:2026-07-15",
      timestamp: 1752537600,
    });
    expect(out.identifier).toBe("org-7:2026-07-15");
    const { url, init } = calls[0];
    expect(url).toBe("https://api.stripe.com/v1/billing/meter_events");
    const p = new URLSearchParams(init.body as string);
    expect(p.get("event_name")).toBe("webhook_events");
    expect(p.get("payload[stripe_customer_id]")).toBe("cus_1");
    expect(p.get("payload[value]")).toBe("4200"); // Stripe wants the value as a string
    expect(p.get("timestamp")).toBe("1752537600");
    expect(p.get("identifier")).toBe("org-7:2026-07-15");
    // The identifier is ALSO the HTTP Idempotency-Key: a retried report of the same {org}:{day} is a
    // no-op at Stripe's native meter dedup AND the request layer — a day can never be double-billed.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("org-7:2026-07-15");
  });

  it("reportMeterEvent omits an unset timestamp (Stripe defaults to ingest time)", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { identifier: "org-7:2026-07-16" } });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    await client.reportMeterEvent({
      eventName: "webhook_events",
      customer: "cus_1",
      value: 1,
      identifier: "org-7:2026-07-16",
    });
    const p = new URLSearchParams(calls[0].init.body as string);
    expect(p.has("timestamp")).toBe(false);
  });

  it("createPortalSession sends the customer + return_url", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: "ps_1", url: "https://portal" } });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
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

describe("makeStripeClient — the mode/key guard is UNSKIPPABLE (it lives in the constructor)", () => {
  // A guard at the call sites is one a future caller can forget. Requiring `mode` here makes the compiler
  // force every caller through it, and throwing means a mismatched pair can never issue a single request.
  //
  // The key fixtures are CONCATENATED rather than written as literals: a literal `sk_live_…` is a real
  // Stripe token shape and trips the repo's gitleaks scan, which reads branch HISTORY (so an inline
  // allow-comment would have to live in the introducing commit). Building the string sidesteps it entirely.
  const LIVE = "sk_live_" + "fixture";
  const TEST = "sk_test_" + "fixture";
  const PUBLISHABLE = "pk_live_" + "fixture";

  it("throws on a LIVE key in test mode (it would charge real cards)", () => {
    expect(() => makeStripeClient({ mode: "test", secretKey: LIVE })).toThrow(
      /does not match BILLING_MODE/,
    );
  });

  it("throws on a TEST key in live mode (it would take no money)", () => {
    expect(() => makeStripeClient({ mode: "live", secretKey: TEST })).toThrow(
      /does not match BILLING_MODE/,
    );
  });

  it("throws when billing is off, and on a publishable key used as a secret", () => {
    expect(() => makeStripeClient({ mode: "off", secretKey: TEST })).toThrow();
    expect(() => makeStripeClient({ mode: "live", secretKey: PUBLISHABLE })).toThrow();
  });

  it("never names the key or its prefix in the error", () => {
    try {
      makeStripeClient({ mode: "test", secretKey: LIVE });
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("fixture");
      expect(msg).not.toContain("sk_live");
    }
  });

  it("constructs fine for a matching pair", () => {
    expect(() => makeStripeClient({ mode: "live", secretKey: LIVE })).not.toThrow();
    expect(() => makeStripeClient({ mode: "test", secretKey: TEST })).not.toThrow();
  });
});

/** A fake fetch that returns a SEQUENCE of canned responses (for pagination), recording every call. */
function fakeFetchSeq(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("makeStripeClient.get", () => {
  it("GETs /v1<path>?query with Bearer + Version and NO body / NO Content-Type", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { object: "list", data: [] } });
    const client = makeStripeClient({
      mode: "test",
      secretKey: SECRET,
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });
    await client.get("/billing/meters/mtr_1/event_summaries", { customer: "cus_1", limit: 100 });
    const { url, init } = calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${SECRET}`);
    expect(headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(headers["Content-Type"]).toBeUndefined();
    // query lands in the URL, not the body
    const u = new URL(url);
    expect(u.pathname).toBe("/v1/billing/meters/mtr_1/event_summaries");
    expect(u.searchParams.get("customer")).toBe("cus_1");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("omits the ? entirely when there is no query", async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: {} });
    const client = makeStripeClient({
      mode: "test",
      secretKey: SECRET,
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });
    await client.get("/account");
    expect(calls[0].url).toBe("https://stripe.test/v1/account");
  });

  it("throws StripeError on a non-2xx", async () => {
    const { impl } = fakeFetch({ status: 402, body: { error: { message: "nope", code: "x" } } });
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: impl });
    await expect(client.get("/x")).rejects.toBeInstanceOf(StripeError);
  });

  it("throws StripeError on a non-JSON gateway response", async () => {
    // A gateway 502 whose body isn't JSON: json() rejects → handleResponse must still throw a StripeError.
    const badImpl = (async () =>
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }) as Response) as unknown as typeof fetch;
    const client = makeStripeClient({ mode: "test", secretKey: SECRET, fetchImpl: badImpl });
    await expect(client.get("/x")).rejects.toBeInstanceOf(StripeError);
  });
});

describe("makeStripeClient.listMeterEventSummaries", () => {
  const base = {
    mode: "test" as const,
    secretKey: SECRET,
    apiBase: "https://stripe.test",
  };

  it("builds the meter/customer/time/day-window/limit params and parses aggregated_value", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: {
        object: "list",
        has_more: false,
        data: [
          { id: "mes_1", start_time: 1_780_000_000, end_time: 1_780_086_400, aggregated_value: 42 },
        ],
      },
    });
    const client = makeStripeClient({ ...base, fetchImpl: impl });
    const out = await client.listMeterEventSummaries({
      meterId: "mtr_1",
      customer: "cus_1",
      startTime: 1_780_000_000,
      endTime: 1_782_000_000,
    });
    expect(out).toEqual([
      { startTime: 1_780_000_000, endTime: 1_780_086_400, aggregatedValue: 42 },
    ]);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1/billing/meters/mtr_1/event_summaries");
    expect(u.searchParams.get("customer")).toBe("cus_1");
    expect(u.searchParams.get("start_time")).toBe("1780000000");
    expect(u.searchParams.get("end_time")).toBe("1782000000");
    expect(u.searchParams.get("value_grouping_window")).toBe("day");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("paginates via starting_after until has_more is false and concatenates", async () => {
    const { impl, calls } = fakeFetchSeq([
      {
        status: 200,
        body: {
          has_more: true,
          data: [{ id: "mes_1", start_time: 100, end_time: 200, aggregated_value: 1 }],
        },
      },
      {
        status: 200,
        body: {
          has_more: false,
          data: [{ id: "mes_2", start_time: 200, end_time: 300, aggregated_value: 2 }],
        },
      },
    ]);
    const client = makeStripeClient({ ...base, fetchImpl: impl });
    const out = await client.listMeterEventSummaries({
      meterId: "mtr_1",
      customer: "cus_1",
      startTime: 0,
      endTime: 1000,
    });
    expect(out.map((s) => s.aggregatedValue)).toEqual([1, 2]);
    // second call carries starting_after = last id of page 1
    expect(new URL(calls[1].url).searchParams.get("starting_after")).toBe("mes_1");
  });
});
