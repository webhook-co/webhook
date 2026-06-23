import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, SECURITY_HEADERS, TURNSTILE_ORIGIN } from "./security-headers";

describe("auth CSP", () => {
  it("locks down framing, plugins, base-uri, and form targets", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("allowlists Cloudflare Turnstile — and ONLY Turnstile — as the third-party origin", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain(`script-src 'self' 'unsafe-inline' ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain(`frame-src ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain(`connect-src 'self' ${TURNSTILE_ORIGIN}`);
    // the captcha is the only off-origin the UI loads — guard against a stray origin sneaking in
    const origins = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set([TURNSTILE_ORIGIN]));
  });
});

describe("auth security headers", () => {
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
