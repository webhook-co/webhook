import { afterEach, describe, expect, it, vi } from "vitest";

import { _clearKeyCache, makeKeyFetcher } from "../src/key-fetch";
import type { KeyFetchSpec } from "@webhook-co/shared";

afterEach(() => _clearKeyCache());

function spec(over: Partial<KeyFetchSpec> = {}): KeyFetchSpec {
  return {
    cacheKey: "k1",
    url: "https://api.paypal.com/v1/notifications/certs/cert.pem",
    allowedHosts: ["api.paypal.com"],
    ttlSeconds: 60,
    ...over,
  };
}
function okFetch(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status }));
}
const decode = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe("makeKeyFetcher", () => {
  it("fetches an allowed https host and returns the response bytes (no redirects)", async () => {
    const f = okFetch("CERTDATA");
    const out = await makeKeyFetcher(() => 1000, f as unknown as typeof fetch)(spec());
    expect(decode(out)).toBe("CERTDATA");
    expect(f).toHaveBeenCalledOnce();
    expect(f).toHaveBeenCalledWith(
      "https://api.paypal.com/v1/notifications/certs/cert.pem",
      expect.objectContaining({ redirect: "error", method: "GET" }),
    );
  });

  it("caches within the TTL (no second fetch)", async () => {
    const f = okFetch("X");
    const fetchKey = makeKeyFetcher(() => 1000, f as unknown as typeof fetch);
    await fetchKey(spec());
    await fetchKey(spec());
    expect(f).toHaveBeenCalledOnce();
  });

  it("re-fetches after the TTL expires", async () => {
    const f = okFetch("X");
    let t = 1000;
    const fetchKey = makeKeyFetcher(() => t, f as unknown as typeof fetch);
    await fetchKey(spec({ ttlSeconds: 1 }));
    t = 1000 + 2000; // +2s, past the 1s TTL
    await fetchKey(spec({ ttlSeconds: 1 }));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("refuses a disallowed host WITHOUT fetching (SSRF guard)", async () => {
    const f = okFetch("X");
    const out = await makeKeyFetcher(
      () => 1,
      f as unknown as typeof fetch,
    )(spec({ url: "https://evil.example/cert.pem" }));
    expect(out).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses non-https without fetching", async () => {
    const f = okFetch("X");
    const out = await makeKeyFetcher(
      () => 1,
      f as unknown as typeof fetch,
    )(spec({ url: "http://api.paypal.com/cert.pem" }));
    expect(out).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("supports a RegExp host allowlist (SNS-style) and rejects a lookalike", async () => {
    const allow = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com$/;
    const f = okFetch("CERT");
    const fetchKey = makeKeyFetcher(() => 1, f as unknown as typeof fetch);
    expect(
      decode(
        await fetchKey(
          spec({ url: "https://sns.us-east-1.amazonaws.com/x.pem", allowedHosts: allow }),
        ),
      ),
    ).toBe("CERT");
    const f2 = okFetch("CERT");
    const out2 = await makeKeyFetcher(
      () => 1,
      f2 as unknown as typeof fetch,
    )(
      spec({
        cacheKey: "k2",
        url: "https://sns.amazonaws.com.evil.com/x.pem",
        allowedHosts: allow,
      }),
    );
    expect(out2).toBeNull();
    expect(f2).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx response and does NOT cache it", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      return new Response(n === 1 ? "nope" : "OK", { status: n === 1 ? 500 : 200 });
    });
    const fetchKey = makeKeyFetcher(() => 1, f as unknown as typeof fetch);
    expect(await fetchKey(spec())).toBeNull();
    expect(decode(await fetchKey(spec()))).toBe("OK"); // retried (failure wasn't cached)
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fails soft (null) when fetch throws (timeout / network / refused redirect)", async () => {
    const f = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await makeKeyFetcher(() => 1, f as unknown as typeof fetch)(spec())).toBeNull();
  });

  it("rejects an oversized response", async () => {
    const f = okFetch("a".repeat(64 * 1024 + 1));
    expect(await makeKeyFetcher(() => 1, f as unknown as typeof fetch)(spec())).toBeNull();
  });

  it("passes POST + body + headers through (Plaid's authenticated key fetch)", async () => {
    const f = okFetch("{}");
    await makeKeyFetcher(
      () => 1,
      f as unknown as typeof fetch,
    )(
      spec({
        url: "https://production.plaid.com/webhook_verification_key/get",
        allowedHosts: ["production.plaid.com"],
        method: "POST",
        body: '{"key_id":"kid"}',
        headers: [["content-type", "application/json"]],
      }),
    );
    expect(f).toHaveBeenCalledWith(
      "https://production.plaid.com/webhook_verification_key/get",
      expect.objectContaining({ method: "POST", body: '{"key_id":"kid"}' }),
    );
  });
});
