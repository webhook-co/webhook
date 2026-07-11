import { describe, expect, it } from "vitest";

import { guardRegister, ipRateBucket, REGISTER_RATE_RULE } from "./register-guard";
import type { RateLimitKv } from "./rate-limit";

// A real in-memory KV so we exercise the actual consumeRateLimit counter (no mocking the limiter).
function fakeKv(): RateLimitKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
  };
}

function registerRequest(ip: string | null, origin?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("cf-connecting-ip", ip);
  if (origin) headers.set("origin", origin);
  return new Request("https://auth.webhook.co/register", { method: "POST", headers });
}

describe("ipRateBucket", () => {
  it("returns an IPv4 address unchanged (the whole address is the bucket)", () => {
    expect(ipRateBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("truncates a full IPv6 address to its /64 prefix (an attacker owns the whole /64)", () => {
    expect(ipRateBucket("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1234:5678");
  });

  it("expands a compressed IPv6 address before taking the /64", () => {
    expect(ipRateBucket("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ipRateBucket("::1")).toBe("0:0:0:0");
  });

  it("buckets an IPv4-mapped IPv6 address by its embedded IPv4 (not the collapsed all-zero /64)", () => {
    // ::ffff:a.b.c.d is a distinct IPv4 client; the naive /64 slice would collapse every mapped address
    // to 0:0:0:0 and share one bucket across unrelated clients.
    expect(ipRateBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipRateBucket("::ffff:198.51.100.9")).toBe("198.51.100.9");
  });
});

describe("guardRegister", () => {
  const deps = (kv: RateLimitKv | undefined) => ({ kv, nowSeconds: () => 1_000_000 });

  it("ignores non-POST requests", async () => {
    const kv = fakeKv();
    const req = new Request("https://auth.webhook.co/register", { method: "GET" });
    expect(await guardRegister(deps(kv), req)).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("ignores POSTs to a different path", async () => {
    const kv = fakeKv();
    const req = new Request("https://auth.webhook.co/oauth/token", { method: "POST" });
    expect(await guardRegister(deps(kv), req)).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("fails open when the KV is unbound (dev/test)", async () => {
    expect(await guardRegister(deps(undefined), registerRequest("203.0.113.7"))).toBeNull();
  });

  it("fails open when cf-connecting-ip is absent (off-edge)", async () => {
    const kv = fakeKv();
    expect(await guardRegister(deps(kv), registerRequest(null))).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("allows registrations under the per-IP limit, then 429s over it", async () => {
    const kv = fakeKv();
    for (let i = 0; i < REGISTER_RATE_RULE.limit; i++) {
      expect(await guardRegister(deps(kv), registerRequest("203.0.113.7"))).toBeNull();
    }
    const blocked = await guardRegister(deps(kv), registerRequest("203.0.113.7"));
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBeTruthy();
    expect(blocked?.headers.get("cache-control")).toContain("no-store");
  });

  it("echoes the request Origin on the 429 so a browser DCR client can read the rate-limit response", async () => {
    // The provider attaches CORS (echoed Origin) to every /register response; our short-circuit 429 must
    // too, or a cross-origin web MCP client (claude.ai / cursor.com) sees an opaque CORS error, not the 429.
    const kv = fakeKv();
    const origin = "https://claude.ai";
    for (let i = 0; i < REGISTER_RATE_RULE.limit; i++) {
      await guardRegister(deps(kv), registerRequest("203.0.113.7", origin));
    }
    const blocked = await guardRegister(deps(kv), registerRequest("203.0.113.7", origin));
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("omits CORS headers on the 429 when there is no Origin (non-browser client)", async () => {
    const kv = fakeKv();
    for (let i = 0; i < REGISTER_RATE_RULE.limit; i++) {
      await guardRegister(deps(kv), registerRequest("203.0.113.7"));
    }
    const blocked = await guardRegister(deps(kv), registerRequest("203.0.113.7"));
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("buckets two addresses in the same IPv6 /64 together (can't evade by rotating low bits)", async () => {
    const kv = fakeKv();
    for (let i = 0; i < REGISTER_RATE_RULE.limit; i++) {
      // Each request a different low-64 address, same /64 prefix.
      expect(
        await guardRegister(deps(kv), registerRequest(`2001:db8:1:2:0:0:0:${i.toString(16)}`)),
      ).toBeNull();
    }
    const blocked = await guardRegister(
      deps(kv),
      registerRequest("2001:db8:1:2:ffff:ffff:ffff:ffff"),
    );
    expect(blocked?.status).toBe(429);
  });

  it("fails open (allows) when the KV throws", async () => {
    const brokenKv: RateLimitKv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => undefined,
    };
    expect(await guardRegister(deps(brokenKv), registerRequest("203.0.113.7"))).toBeNull();
  });
});
