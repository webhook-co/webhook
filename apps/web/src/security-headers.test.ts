import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, securityHeaders } from "./security-headers";

describe("dashboard CSP (production)", () => {
  it("locks down framing, plugins, base-uri, and form targets", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("allows inline script/style (OpenNext hydration); fetch directives inherit default-src 'self'", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // connect-src/font-src are omitted as redundant — default-src 'self' is their fallback. Pin that they
    // stay omitted so the redundancy can't creep back; a future cross-origin need adds a real value, not 'self'.
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toContain("font-src");
    // NO eval in production — React never uses it; only `next dev` does.
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("loads NO third-party origin (unlike apps/auth's Turnstile allowlist)", () => {
    const csp = buildContentSecurityPolicy();
    const origins = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(origins).toEqual([]);
  });
});

describe("dashboard CSP (development)", () => {
  it("adds 'unsafe-eval' + the HMR websocket for `next dev` (Turbopack), prod does not", () => {
    const dev = buildContentSecurityPolicy(true);
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws: wss:");
    // The prod policy must NOT carry either relaxation.
    const prod = buildContentSecurityPolicy(false);
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("ws:");
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
