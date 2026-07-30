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

/** Every http(s) origin named anywhere in a policy string. */
const originsIn = (csp: string) => new Set(csp.match(/https?:\/\/[^\s;]+/g) ?? []);

describe("auth CSP — dev vs production", () => {
  // `next dev` (Turbopack) evaluates client modules with eval() and opens an HMR websocket. The auth app
  // had NO dev/production split — unlike apps/web, which has carried one since it shipped — so `next dev`
  // served the tight production policy, eval was refused, and the dev client runtime never booted: React
  // did not hydrate, no effect ran, and the Turnstile script was never fetched. It presented as a
  // permanently-stuck "Verifying you're human…" button, i.e. as a broken captcha rather than as a CSP
  // problem. Nothing caught it because nothing had ever opened this page in a browser (see
  // playwright/login.spec.ts, which is what finally did).
  it("allows eval ONLY in dev, where Turbopack requires it", () => {
    expect(buildContentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });

  it("never allows eval in the production policy", () => {
    expect(buildContentSecurityPolicy(false)).not.toContain("'unsafe-eval'");
  });

  it("defaults to the PRODUCTION policy when called with no argument", () => {
    // Fail-closed: a caller that forgets the flag must get the tight policy, never the relaxed one.
    expect(buildContentSecurityPolicy()).toBe(buildContentSecurityPolicy(false));
  });

  it("ships the production policy in SECURITY_HEADERS' default export shape", () => {
    const csp = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value])).get(
      "Content-Security-Policy",
    );
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("never widens the third-party origin allowlist in dev", () => {
    // The dev relaxation is about eval and the HMR socket ONLY. If it ever also admitted an origin, a
    // third party could be exercised locally and silently refused in production — the precise asymmetry
    // AGENTS.md guardrail 2 forbids, and the one that would make the browser CSP check worthless.
    expect(originsIn(buildContentSecurityPolicy(true))).toEqual(
      originsIn(buildContentSecurityPolicy(false)),
    );
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
