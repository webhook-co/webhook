import { describe, expect, it, vi } from "vitest";

import { ONE_TAP_CALLBACK_URL_PATH } from "../runtime/urls";

// Every `*-deps` module is a DEPENDENCY FACTORY that opens a pg Pool or reaches for `cloudflare:workers`
// (via getOAuthApi), neither of which resolves under jsdom. They are stubbed so this file can import the
// dispatch at all. Note what is NOT stubbed: `edge-rate-limit`, `ip-throttle` and the routing logic are
// the real implementations, so the gate under test is genuinely exercised. The stubs only stand in for
// branches these tests never take — a request that reached one would fail loudly on the stub, not pass.
vi.mock("./authorize-deps", () => ({ makeAuthorizeDeps: vi.fn() }));
vi.mock("./device-authorize-deps", () => ({ makeDeviceAuthorizeDeps: vi.fn() }));
vi.mock("./device-verify-deps", () => ({ makeDeviceVerifyDeps: vi.fn() }));
vi.mock("./logout-deps", () => ({ makeLogoutDeps: vi.fn() }));
vi.mock("./revoke-deps", () => ({ makeRevokeDeps: vi.fn() }));
vi.mock("./session-exchange-deps", () => ({ makeSessionExchangeDeps: vi.fn() }));
vi.mock("./session-handoff-deps", () => ({ makeSessionHandoffDeps: vi.fn() }));
vi.mock("./token-deps", () => ({ makeTokenDeps: vi.fn() }));

const { makeIssuerDefaultHandler } = await import("./issuer-handler");

// The One Tap callback is the ONLY path this dispatch gates without also handling: it throttles and then
// falls through to OpenNext, where better-auth's own handler serves it. That shape is what these tests
// pin, because both halves are easy to break independently — a `return` in the wrong place silently
// 404s every One Tap sign-in, and a missing gate silently leaves the endpoint unmetered.
//
// Why it needs a gate at all: `POST /api/auth/one-tap/callback` is public and unauthenticated, and on any
// body carrying a well-formed JWT header it calls Google's certs endpoint through `getGooglePublicKey`,
// which holds no cache of its own — one outbound subrequest per request. better-auth's own limiter for
// this path is the generic 100-req/10s, which is in-memory and per-isolate and therefore fleet-wide
// ineffective, the same reason the magic-link send got a durable throttle instead.

const fakeKv = () => {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, _opts: { expirationTtl: number }) => void store.set(k, v),
  };
};

/** A stand-in for the generated OpenNext handler, so "did it fall through" is directly observable. */
const fakeOpenNext = () => ({
  fetch: vi.fn(async () => new Response("open-next", { status: 200 })),
});

const post = (path: string, ip = "1.2.3.4") =>
  new Request(`https://auth.webhook.co${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
    body: JSON.stringify({ idToken: "not-a-jwt" }),
  });

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("One Tap callback edge throttle", () => {
  it("falls THROUGH to OpenNext when under the limit (better-auth still serves the endpoint)", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    const res = await handler.fetch(
      post(ONE_TAP_CALLBACK_URL_PATH),
      { RATELIMIT_KV: fakeKv() },
      ctx,
    );

    expect(openNext.fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("open-next");
  });

  it("returns 429 and does NOT reach OpenNext once the per-IP window is exhausted", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    const env = { RATELIMIT_KV: fakeKv() };

    let last: Response | undefined;
    // One more than the rule allows; the rule is deliberately not restated here so a retune of the
    // number does not require touching this test.
    for (let i = 0; i < 200; i++) {
      last = await handler.fetch(post(ONE_TAP_CALLBACK_URL_PATH), env, ctx);
      if (last.status === 429) break;
    }

    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    // The gate must short-circuit BEFORE OpenNext, or the throttle saves nothing: the whole point is
    // that a blocked request never reaches better-auth and never triggers the Google certs fetch.
    const callsBeforeBlock = openNext.fetch.mock.calls.length;
    await handler.fetch(post(ONE_TAP_CALLBACK_URL_PATH), env, ctx);
    expect(openNext.fetch.mock.calls.length).toBe(callsBeforeBlock);
  });

  it("keys per client IP — one abusive IP cannot lock everyone else out", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    const env = { RATELIMIT_KV: fakeKv() };

    for (let i = 0; i < 200; i++) {
      const r = await handler.fetch(post(ONE_TAP_CALLBACK_URL_PATH, "9.9.9.9"), env, ctx);
      if (r.status === 429) break;
    }
    const other = await handler.fetch(post(ONE_TAP_CALLBACK_URL_PATH, "5.5.5.5"), env, ctx);
    expect(other.status).toBe(200);
  });

  // FAIL OPEN. A KV outage must not take One Tap down — this is a volume throttle, not a correctness
  // gate, and the same policy every other edge rule here follows.
  it("falls through when the rate-limit KV is unbound (dev/test, and a KV outage)", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    for (let i = 0; i < 50; i++) {
      const res = await handler.fetch(post(ONE_TAP_CALLBACK_URL_PATH), {}, ctx);
      expect(res.status).toBe(200);
    }
    expect(openNext.fetch).toHaveBeenCalledTimes(50);
  });

  // The gate is keyed on the exact path AND method. A GET is not the callback, and neither is a
  // sibling better-auth route — throttling those would be a silent availability bug.
  it("does not gate a GET to the same path", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    const env = { RATELIMIT_KV: fakeKv() };
    for (let i = 0; i < 200; i++) {
      const res = await handler.fetch(
        new Request(`https://auth.webhook.co${ONE_TAP_CALLBACK_URL_PATH}`, {
          method: "GET",
          headers: { "cf-connecting-ip": "1.2.3.4" },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
    }
  });

  it("does not gate a different /api/auth route", async () => {
    const openNext = fakeOpenNext();
    const handler = makeIssuerDefaultHandler(openNext);
    const env = { RATELIMIT_KV: fakeKv() };
    for (let i = 0; i < 200; i++) {
      const res = await handler.fetch(post("/api/auth/sign-in/magic-link"), env, ctx);
      expect(res.status).toBe(200);
    }
  });

  // Pins OUR constant only — it reads nothing from better-auth, so an upstream path rename would sail
  // straight through it. What actually proves the endpoint is mounted where we throttle is
  // one-tap-contract.test.ts, which POSTs to this path against a real betterAuth() instance and asserts
  // 400 rather than 404. This is the cheap change-detector that sits under that.
  it("pins the request path the throttle matches on", () => {
    expect(ONE_TAP_CALLBACK_URL_PATH).toBe("/api/auth/one-tap/callback");
  });
});
