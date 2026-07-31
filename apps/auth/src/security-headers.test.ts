import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  GOOGLE_IDENTITY_ORIGIN,
  SECURITY_HEADERS,
  TURNSTILE_ORIGIN,
} from "./security-headers";

// The production policy, spelled out IN THE TEST rather than derived from the module under test. Written
// this way on purpose: a `toContain` per directive silently tolerates a widened one (`script-src 'self'
// … https://evil.example` still contains the expected prefix), and rebuilding the expectation from the
// same `cspDirectives` it is checking would assert only that a function equals itself. A full literal is
// the only form where ANY change — a new origin, a dropped directive, a reordering — has to be made
// deliberately, in this file, where a reviewer sees it.
const PRODUCTION_CSP: ReadonlyArray<[string, string]> = [
  ["default-src", "'self'"],
  ["script-src", `'self' 'unsafe-inline' ${TURNSTILE_ORIGIN} ${GOOGLE_IDENTITY_ORIGIN}`],
  ["style-src", `'self' 'unsafe-inline' ${GOOGLE_IDENTITY_ORIGIN}`],
  ["img-src", "'self' data:"],
  ["font-src", "'self'"],
  ["connect-src", `'self' ${TURNSTILE_ORIGIN} ${GOOGLE_IDENTITY_ORIGIN}`],
  ["frame-src", `${TURNSTILE_ORIGIN} ${GOOGLE_IDENTITY_ORIGIN}`],
  ["frame-ancestors", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
  ["object-src", "'none'"],
];

/** One directive's value, read out of a SERIALIZED policy — i.e. out of the code, not out of a fixture. */
const directiveIn = (csp: string, directive: string): string =>
  csp.split("; ").find((part) => part.startsWith(`${directive} `)) ?? "";

describe("auth CSP", () => {
  it("serializes EXACTLY the production policy — every directive, every value", () => {
    expect(buildContentSecurityPolicy()).toBe(
      PRODUCTION_CSP.map(([directive, value]) => `${directive} ${value}`).join("; "),
    );
  });

  it("locks down framing, plugins, base-uri, and form targets", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  // The set-equality is the part that catches a stray origin. It used to name Turnstile alone; the login
  // page now also loads Google Identity Services for One Tap, so the allowlist is TWO — and still a
  // closed set, which is the property worth keeping.
  it("allowlists exactly two third-party origins, and no others", () => {
    const origins = buildContentSecurityPolicy().match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set([TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN]));
  });

  // Empirically derived (playwright, four engines) — see GOOGLE_IDENTITY_ORIGIN for the evidence and for
  // what the experiment could NOT settle. style-src is called out because it is the one commonly missed:
  // GSI loads an external stylesheet, which 'unsafe-inline' does not cover.
  it("grants Google Identity Services exactly the directives One Tap needs", () => {
    // Read from the CODE, never from PRODUCTION_CSP. Asserting the fixture against itself is how a test
    // ends up unable to fail for the reason its name gives.
    const csp = buildContentSecurityPolicy();
    for (const directive of ["script-src", "style-src", "connect-src", "frame-src"]) {
      expect(directiveIn(csp, directive)).toContain(GOOGLE_IDENTITY_ORIGIN);
    }
  });

  it("does NOT grant Google img-src — the avatar is never governed by this page's CSP", () => {
    // Under FedCM it is browser chrome; under the legacy path it is inside a cross-origin iframe. Adding
    // lh3.googleusercontent.com here would widen the policy for something it cannot affect.
    expect(directiveIn(buildContentSecurityPolicy(), "img-src")).not.toContain("google");
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

  // FedCM is gated by `identity-credentials-get`. It already defaults to `self` for a top-level document,
  // so this pins today's behaviour against a future tightening that would silently kill One Tap.
  it("permits the FedCM credential request, and still denies camera/mic/geolocation", () => {
    const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), identity-credentials-get=(self)",
    );
  });
});
