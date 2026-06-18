import { describe, expect, it } from "vitest";

import { InvalidForwardUrlError } from "./errors.js";
import {
  filterForwardHeaders,
  forwardToLocalhost,
  isDelivered,
  parseForwardTarget,
} from "./forward.js";

const BODY = new TextEncoder().encode('{"a":1}');

describe("parseForwardTarget", () => {
  it("accepts http(s) loopback URLs", () => {
    expect(parseForwardTarget("http://localhost:3000/webhooks").hostname).toBe("localhost");
    expect(parseForwardTarget("http://127.0.0.1:3000").hostname).toBe("127.0.0.1");
    expect(parseForwardTarget("https://localhost:8443").protocol).toBe("https:");
  });

  it("rejects non-loopback hosts, non-http schemes, and garbage", () => {
    for (const bad of [
      "http://evil.example",
      "https://10.0.0.5",
      "ws://localhost",
      "ftp://localhost",
      "not a url",
    ]) {
      expect(() => parseForwardTarget(bad), bad).toThrow(InvalidForwardUrlError);
    }
  });
});

describe("filterForwardHeaders", () => {
  it("drops hop-by-hop / host / length but keeps signature + content-type headers", () => {
    const h = filterForwardHeaders([
      ["host", "wbhk.my"],
      ["content-length", "10"],
      ["connection", "keep-alive"],
      ["content-type", "application/json"],
      ["webhook-id", "msg_1"],
      ["webhook-signature", "v1,abc"],
      ["webhook-timestamp", "123"],
    ]);
    expect(h.get("host")).toBeNull();
    expect(h.get("content-length")).toBeNull();
    expect(h.get("connection")).toBeNull();
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("webhook-id")).toBe("msg_1");
    expect(h.get("webhook-signature")).toBe("v1,abc");
    expect(h.get("webhook-timestamp")).toBe("123");
  });
});

describe("forwardToLocalhost", () => {
  it("POSTs exact bytes + filtered headers and returns the local status + latency", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    let clock = 1000;
    const out = await forwardToLocalhost(
      { fetch: fetchImpl, now: () => (clock += 25) },
      {
        targetUrl: "http://localhost:3000/hook",
        headers: [
          ["content-type", "application/json"],
          ["host", "wbhk.my"],
        ],
        body: BODY,
      },
    );
    expect(out).toEqual({ ok: true, status: 200, latencyMs: 25 });
    expect(isDelivered(out)).toBe(true);
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.body).toBe(BODY); // exact bytes, no re-encode
    const fwd = seen?.init.headers as Headers;
    expect(fwd.get("host")).toBeNull();
    expect(fwd.get("content-type")).toBe("application/json");
  });

  it("returns ok:false with the reason when the connection fails (no throw)", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    }) as unknown as typeof fetch;
    const out = await forwardToLocalhost(
      { fetch: fetchImpl, now: () => 0 },
      { targetUrl: "http://localhost:3000", headers: [], body: BODY },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("ECONNREFUSED");
    expect(isDelivered(out)).toBe(false);
  });

  it("treats a non-2xx local response as reached-but-not-delivered", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const out = await forwardToLocalhost(
      { fetch: fetchImpl, now: () => 0 },
      { targetUrl: "http://localhost:3000", headers: [], body: BODY },
    );
    expect(out).toMatchObject({ ok: true, status: 500 });
    expect(isDelivered(out)).toBe(false);
  });

  it("never follows a redirect off-machine (3xx surfaces as reached-but-not-delivered)", async () => {
    let seenRedirect: unknown;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "http://evil.example/steal" },
      });
    }) as unknown as typeof fetch;
    const out = await forwardToLocalhost(
      { fetch: fetchImpl, now: () => 0 },
      { targetUrl: "http://localhost:3000", headers: [], body: BODY },
    );
    expect(seenRedirect).toBe("manual"); // redirects are NOT auto-followed (loopback guard is initial-only)
    expect(out).toMatchObject({ ok: true, status: 302 });
    expect(isDelivered(out)).toBe(false);
  });

  it("rejects a non-loopback target BEFORE fetching", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null);
    }) as unknown as typeof fetch;
    await expect(
      forwardToLocalhost(
        { fetch: fetchImpl, now: () => 0 },
        { targetUrl: "http://evil.example", headers: [], body: BODY },
      ),
    ).rejects.toThrow(InvalidForwardUrlError);
    expect(called).toBe(false);
  });
});
