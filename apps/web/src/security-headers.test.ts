import { describe, expect, it } from "vitest";

import {
  AUTHENTICATED_ROUTE_SOURCES,
  buildContentSecurityPolicy,
  noStoreHeaders,
  securityHeaders,
} from "./security-headers";

describe("dashboard CSP (production)", () => {
  it("locks down framing, plugins, base-uri, and form targets", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("allows inline script/style (OpenNext hydration); unused fetch directives inherit default-src 'self'", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("default-src 'self'");
    // font-src has no cross-origin need → stays omitted (inherits default-src). Pin it so redundancy can't creep back.
    expect(csp).not.toContain("font-src");
    // NO eval in production — React never uses it; only `next dev` does.
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("allowlists the ingest apex on connect-src for the live-events WebSocket (ADR-0102)", () => {
    const csp = buildContentSecurityPolicy();
    // The live tail opens a wss socket to the ingest apex; default-src 'self' would block it.
    expect(csp).toContain("connect-src 'self' https://wbhk.my wss://wbhk.my");
  });

  it("allowlists ONLY the ingest apex — no other third-party origin (unlike apps/auth's Turnstile)", () => {
    const csp = buildContentSecurityPolicy();
    const origins = csp.match(/https?:\/\/[^\s;]+|wss?:\/\/[^\s;]+/g) ?? [];
    // Exactly the two ingest-apex origins (https + wss); nothing else.
    expect(new Set(origins)).toEqual(new Set(["https://wbhk.my", "wss://wbhk.my"]));
  });

  it("derives the connect-src apex from INGEST_BASE_URL (no hardcoded drift with the socket URL)", () => {
    const prev = process.env.INGEST_BASE_URL;
    process.env.INGEST_BASE_URL = "https://ingest.self-host.example";
    try {
      const csp = buildContentSecurityPolicy();
      expect(csp).toContain(
        "connect-src 'self' https://ingest.self-host.example wss://ingest.self-host.example",
      );
    } finally {
      if (prev === undefined) delete process.env.INGEST_BASE_URL;
      else process.env.INGEST_BASE_URL = prev;
    }
  });
});

describe("dashboard CSP (development)", () => {
  it("adds 'unsafe-eval' + the HMR websocket for `next dev` (Turbopack), prod does not", () => {
    const dev = buildContentSecurityPolicy(true);
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws: wss:");
    // The prod policy must NOT carry either relaxation: no eval, and its connect-src is the pinned ingest
    // apex — never the broad `ws:`/`wss:` scheme wildcards dev uses for the HMR socket.
    const prod = buildContentSecurityPolicy(false);
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("connect-src 'self' ws: wss:");
    expect(prod).not.toMatch(/connect-src[^;]*\bws:/);
  });
});

describe("dashboard security headers", () => {
  it("ships the standard hardening headers alongside the CSP", () => {
    const byKey = new Map(securityHeaders().map((h) => [h.key, h.value]));
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("Permissions-Policy")).toContain("geolocation=()");
    expect(byKey.get("Strict-Transport-Security")).toContain("max-age=");
    expect(byKey.has("Content-Security-Policy")).toBe(true);
  });
});

// Authenticated HTML must never become a stored response. Today Next already emits no-store on these routes
// (they all read cookies(), so they render dynamically) — but that is an emergent default, not a defended
// invariant, and `Clear-Site-Data: "cache"` on logout used to be the backstop until it was removed for costing
// ~25s of every logout. These assertions ARE the backstop now.
describe("noStoreHeaders", () => {
  const byKey = new Map(noStoreHeaders().map((h) => [h.key, h.value]));

  it("forbids storing authenticated HTML anywhere", () => {
    const value = byKey.get("Cache-Control") ?? "";
    expect(value).toContain("no-store");
    expect(value).toContain("private");
  });
});

describe("AUTHENTICATED_ROUTE_SOURCES", () => {
  it("covers the post-login landing, every org-scoped page, and invite acceptance", () => {
    expect(AUTHENTICATED_ROUTE_SOURCES).toContain("/");
    expect(AUTHENTICATED_ROUTE_SOURCES).toContain("/org/:path*");
    expect(AUTHENTICATED_ROUTE_SOURCES).toContain("/invite/:path*");
  });

  // The whole reason this is a route ALLOWLIST and not `/(.*)`: no-store on the content-hashed, immutable
  // /_next/static bundles would be a large self-inflicted performance regression — the exact opposite of why
  // the header that used to cover this was removed.
  it("never matches the static asset bundles", () => {
    for (const source of AUTHENTICATED_ROUTE_SOURCES) {
      expect(source).not.toContain("_next");
      expect(source).not.toBe("/(.*)");
    }
  });
});
