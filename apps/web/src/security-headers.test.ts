import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, SECURITY_HEADERS } from "./security-headers";

describe("dashboard CSP", () => {
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
  });

  it("loads NO third-party origin (unlike apps/auth's Turnstile allowlist)", () => {
    const csp = buildContentSecurityPolicy();
    const origins = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(origins).toEqual([]);
  });
});

describe("dashboard security headers", () => {
  it("ships the standard hardening headers alongside the CSP", () => {
    const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("Permissions-Policy")).toContain("geolocation=()");
    expect(byKey.get("Strict-Transport-Security")).toContain("max-age=");
    expect(byKey.has("Content-Security-Policy")).toBe(true);
  });
});
