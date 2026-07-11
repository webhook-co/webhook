import { describe, expect, it } from "vitest";

import { EDGE_RULES, edgeRateLimit, type EdgeEndpoint } from "./edge-rate-limit";

// Per-endpoint, per-client-IP edge rate-limiting for the issuer's public endpoints. Reuses the durable
// fixed-window consumeRateLimit; FAILS OPEN (a KV outage / unbound binding must never block legit
// token/login traffic — these are volume throttles, not the device-verify guess-throttle).

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, _opts: { expirationTtl: number }) => {
      store.set(k, v);
    },
  };
}
const now = () => 1000;
const reqFrom = (ip: string | null, origin?: string) => {
  const headers = new Headers();
  if (ip) headers.set("cf-connecting-ip", ip);
  if (origin) headers.set("origin", origin);
  return new Request("https://auth.webhook.co/x", { method: "POST", headers });
};

describe("edgeRateLimit", () => {
  it("allows under the limit (returns null → proceed)", async () => {
    const res = await edgeRateLimit(
      { kv: fakeKv(), nowSeconds: now },
      "token",
      reqFrom("1.2.3.4"),
      {
        limit: 3,
        windowSeconds: 60,
      },
    );
    expect(res).toBeNull();
  });

  it("returns 429 + Retry-After once the per-IP window is exhausted", async () => {
    const kv = fakeKv();
    const rule = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      expect(
        await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4"), rule),
      ).toBeNull();
    }
    const blocked = await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4"), rule);
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked?.headers.get("cache-control")).toContain("no-store");
  });

  it("keys per client IP — a different IP is unaffected", async () => {
    const kv = fakeKv();
    const rule = { limit: 1, windowSeconds: 60 };
    await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.1.1.1"), rule);
    expect(
      (await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.1.1.1"), rule))?.status,
    ).toBe(429);
    expect(
      await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("2.2.2.2"), rule),
    ).toBeNull();
  });

  it("keys per endpoint — the same IP on a different endpoint is independent", async () => {
    const kv = fakeKv();
    const rule = { limit: 1, windowSeconds: 60 };
    await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.1.1.1"), rule);
    expect(
      await edgeRateLimit({ kv, nowSeconds: now }, "revoke", reqFrom("1.1.1.1"), rule),
    ).toBeNull();
  });

  it("fails OPEN (skips the gate) when there's no client IP — no poisonable shared bucket", async () => {
    const res = await edgeRateLimit({ kv: fakeKv(), nowSeconds: now }, "token", reqFrom(null), {
      limit: 1,
      windowSeconds: 60,
    });
    expect(res).toBeNull();
  });

  it("fails OPEN when the KV binding is absent (dev/test, unbound)", async () => {
    const res = await edgeRateLimit(
      { kv: undefined, nowSeconds: now },
      "token",
      reqFrom("1.2.3.4"),
      {
        limit: 1,
        windowSeconds: 60,
      },
    );
    expect(res).toBeNull();
  });

  it("fails OPEN when KV throws (never block legit traffic on a limiter fault)", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {},
    };
    const res = await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4"), {
      limit: 1,
      windowSeconds: 60,
    });
    expect(res).toBeNull();
  });

  it("buckets an IPv6 client by its /64 — rotating the low 64 bits can't mint fresh windows", async () => {
    // A consumer IPv6 allocation is a whole /64 the client fully controls. Keying on the full address
    // makes the gate free to evade: every request from a new low-64 address gets a virgin counter. The
    // register guard already truncates to /64; the token/authorize/device gates are the valuable ones.
    const kv = fakeKv();
    const rule = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      expect(
        await edgeRateLimit(
          { kv, nowSeconds: now },
          "token",
          reqFrom(`2001:db8:1:2:0:0:0:${i.toString(16)}`),
          rule,
        ),
      ).toBeNull();
    }
    const blocked = await edgeRateLimit(
      { kv, nowSeconds: now },
      "token",
      reqFrom("2001:db8:1:2:ffff:ffff:ffff:ffff"),
      rule,
    );
    expect(blocked?.status).toBe(429);
  });

  it("keeps distinct IPv6 /64s independent", async () => {
    const kv = fakeKv();
    const rule = { limit: 1, windowSeconds: 60 };
    await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("2001:db8:1:2::1"), rule);
    expect(
      (await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("2001:db8:1:2::9"), rule))
        ?.status,
    ).toBe(429);
    expect(
      await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("2001:db8:1:3::1"), rule),
    ).toBeNull();
  });

  it("echoes the request Origin on the 429 so a browser MCP client can read it, not an opaque CORS error", async () => {
    // /authorize + /token are reachable cross-origin from the allowlisted web clients. Without CORS on the
    // short-circuit 429, the browser surfaces an opaque network error and the client fails silently — it
    // can never see the Retry-After it is supposed to honour.
    const kv = fakeKv();
    const rule = { limit: 1, windowSeconds: 60 };
    const origin = "https://claude.ai";
    await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4", origin), rule);
    const blocked = await edgeRateLimit(
      { kv, nowSeconds: now },
      "token",
      reqFrom("1.2.3.4", origin),
      rule,
    );
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("omits CORS on the 429 when there is no Origin (non-browser client)", async () => {
    const kv = fakeKv();
    const rule = { limit: 1, windowSeconds: 60 };
    await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4"), rule);
    const blocked = await edgeRateLimit({ kv, nowSeconds: now }, "token", reqFrom("1.2.3.4"), rule);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("ships a sane rule for every gated endpoint", () => {
    const endpoints: EdgeEndpoint[] = [
      "token",
      "revoke",
      "authorize",
      "consent_decision",
      "consent_complete",
      "device_authorization",
      "device_verify",
      "session_handoff",
      "session_exchange",
    ];
    for (const e of endpoints) {
      expect(EDGE_RULES[e].limit).toBeGreaterThan(0);
      // KV's fixed-window minimum is 60s.
      expect(EDGE_RULES[e].windowSeconds).toBeGreaterThanOrEqual(60);
    }
  });

  it("gates every public issuer endpoint — no branch ships without a volume rule", () => {
    // device_verify carries its own guess-throttle (fails CLOSED), but that is a per-user-code correctness
    // gate, not a volume gate: without an edge rule the branch is still an unmetered public POST.
    expect(Object.keys(EDGE_RULES)).toContain("device_verify");
  });
});
