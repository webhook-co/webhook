import { PROVIDER_DOMAINS } from "@webhook-co/ui";
import { describe, expect, it, vi } from "vitest";

import {
  ICON_CACHE_CONTROL,
  isAllowedIconDomain,
  serveProviderIcon,
  upstreamFaviconUrl,
  type IconFetchDeps,
} from "./provider-icon";

// The favicon proxy is an ALLOWLISTED, edge-cached same-origin route: it only ever fetches a favicon for a
// domain that is a value in PROVIDER_DOMAINS (never an attacker-supplied host → no SSRF / open proxy), and
// it constructs a FIXED upstream URL (Google's favicon service) with the domain as an encoded query param.

describe("isAllowedIconDomain", () => {
  it("accepts a domain that is in the provider allowlist", () => {
    expect(isAllowedIconDomain("twilio.com")).toBe(true);
    expect(isAllowedIconDomain("slack.com")).toBe(true);
  });

  it("rejects an unknown host (no open proxy / SSRF)", () => {
    expect(isAllowedIconDomain("evil.example.com")).toBe(false);
    expect(isAllowedIconDomain("169.254.169.254")).toBe(false);
    expect(isAllowedIconDomain("localhost")).toBe(false);
    expect(isAllowedIconDomain("")).toBe(false);
    expect(isAllowedIconDomain(null)).toBe(false);
  });

  it("rejects a domain that only CONTAINS an allowlisted one (exact match, not substring)", () => {
    expect(isAllowedIconDomain("twilio.com.evil.com")).toBe(false);
    expect(isAllowedIconDomain("nottwilio.com")).toBe(false);
  });

  it("every value in the allowlist is accepted (the allowlist IS the source of truth)", () => {
    for (const domain of Object.values(PROVIDER_DOMAINS)) {
      expect(isAllowedIconDomain(domain), domain).toBe(true);
    }
  });
});

describe("upstreamFaviconUrl", () => {
  it("targets the FIXED Google favicon host with the domain url-encoded as a query param", () => {
    const url = new URL(upstreamFaviconUrl("twilio.com"));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/s2/favicons");
    expect(url.searchParams.get("domain")).toBe("twilio.com");
    expect(url.searchParams.get("sz")).toBe("64"); // 4x the 16px tile — crisp on retina
  });

  it("never lets the domain escape the query param (host stays fixed)", () => {
    // even a hostile-looking value can't change the host — it's only ever a query value
    const url = new URL(upstreamFaviconUrl("a.com/../../evil"));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/s2/favicons");
  });
});

describe("ICON_CACHE_CONTROL", () => {
  it("caches immutably for ~a year (favicons are effectively static)", () => {
    expect(ICON_CACHE_CONTROL).toContain("public");
    expect(ICON_CACHE_CONTROL).toContain("immutable");
    expect(ICON_CACHE_CONTROL).toMatch(/max-age=\d{7,}/); // >= 1,000,000s
  });
});

describe("serveProviderIcon", () => {
  const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });

  it("404s an unknown domain WITHOUT any upstream fetch (allowlist gate = no open proxy)", async () => {
    const fetch = vi.fn();
    const res = await serveProviderIcon("https://app/api/provider-icon?domain=evil.example.com", {
      fetch,
    });
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404s a missing domain param without fetching", async () => {
    const fetch = vi.fn();
    const res = await serveProviderIcon("https://app/api/provider-icon", { fetch });
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("on a cache MISS: fetches the fixed upstream, returns image/png + immutable cache + nosniff, and caches", async () => {
    const fetch = vi.fn(async () => png());
    const cachePut = vi.fn(async () => {});
    const deps: IconFetchDeps = { fetch, cacheMatch: async () => undefined, cachePut };
    const res = await serveProviderIcon("https://app/api/provider-icon?domain=twilio.com", deps);
    expect(fetch).toHaveBeenCalledWith(upstreamFaviconUrl("twilio.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png"); // forced — a surprise SVG can't be active
    expect(res.headers.get("cache-control")).toBe(ICON_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("on a cache HIT: returns the cached response and does NOT fetch upstream", async () => {
    const fetch = vi.fn();
    const hit = new Response("cached", { status: 200, headers: { "x-cache": "1" } });
    const res = await serveProviderIcon("https://app/api/provider-icon?domain=slack.com", {
      fetch,
      cacheMatch: async () => hit,
    });
    expect(res.headers.get("x-cache")).toBe("1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404s (no throw) when the upstream fetch fails or is not ok", async () => {
    const throwing = await serveProviderIcon("https://app/api/provider-icon?domain=slack.com", {
      fetch: async () => {
        throw new Error("network");
      },
    });
    expect(throwing.status).toBe(404);
    const notOk = await serveProviderIcon("https://app/api/provider-icon?domain=slack.com", {
      fetch: async () => new Response(null, { status: 500 }),
    });
    expect(notOk.status).toBe(404);
  });
});
