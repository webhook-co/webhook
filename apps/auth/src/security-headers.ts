/**
 * Security response headers for the auth.webhook.co UI (login / consent / device), wired into
 * next.config.ts `headers()` so OpenNext applies them to every Next-served response.
 *
 * CSP shape + the `'unsafe-inline'` tradeoff: OpenNext on Workers has no middleware (ADR-0021), so the UI
 * can't mint a per-request nonce — the same constraint apps/www documents. Script/style therefore fall back
 * to `'unsafe-inline'` (Next's hydration injects inline `<script>`/`<style>`). React's output-escaping
 * stays the primary XSS defense; this CSP is defense-in-depth that still locks down framing, base-uri,
 * plugins, form targets, and the connect/script/frame origins to `'self'` plus the one third-party the UI
 * loads — Cloudflare Turnstile (the login captcha: its script + widget iframe + telemetry all live on
 * challenges.cloudflare.com). A nonce/hash CSP is a follow-up gated on a Workers nonce-injection story.
 * See docs/adr/0056-auth-csp.md.
 */

/** Cloudflare Turnstile — the login captcha (script + widget iframe + telemetry). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Google Identity Services — the One Tap prompt on the login page.
 *
 * The directive set below was determined EMPIRICALLY (playwright, four engines: Chrome with FedCM,
 * Chrome with FedCM force-disabled, Firefox, Safari/WebKit), not from Google's documentation, which says
 * only that "changes are needed" without naming values. Findings:
 *
 *   PROVEN NEEDED — every engine issued the request, and removing the directive blocks it outright:
 *     • script-src  — GET /gsi/client. Blocked first, which stops everything downstream, so it had to be
 *                     allowed before any other directive could even be observed.
 *     • style-src   — GET /gsi/style. GSI loads an EXTERNAL stylesheet, and `'unsafe-inline'` does not
 *                     cover that. Worth stating because it is the one people leave out.
 *     • connect-src — /gsi/fedcm.json (the FedCM manifest) and /gsi/log. Chrome-with-FedCM issues the
 *                     first as an `other`-type request and the three non-FedCM engines issue XHRs.
 *
 *   INCLUDED ON DOCUMENTED BEHAVIOUR, NOT ON AN OBSERVED REQUEST:
 *     • frame-src   — no engine requested an iframe during discovery, and it would be wrong to conclude
 *                     none is needed. The runs had NO Google account signed in ("Provider's accounts list
 *                     is empty"), so the prompt never rendered in any engine — the experiment could only
 *                     ever show what loading and initializing costs, never what DISPLAYING costs. Google's
 *                     legacy (non-FedCM) One Tap renders in an accounts.google.com iframe, and Safari and
 *                     Firefox have no FedCM, so omitting this would break the prompt for exactly those
 *                     users, in a way that only shows up for someone with a live Google session. Kept.
 *
 *   DELIBERATELY NOT ADDED:
 *     • img-src     — the account avatar is either browser chrome (FedCM) or content INSIDE a cross-origin
 *                     iframe (legacy). Neither is governed by this page's CSP, so allowing
 *                     lh3.googleusercontent.com here would widen the policy for nothing.
 *
 * The frame-src question is on the human-verification checklist precisely because it is the one the
 * experiment could not settle.
 */
export const GOOGLE_IDENTITY_ORIGIN = "https://accounts.google.com";

// Insertion order is the serialized order. Each value array is space-joined; directives are "; "-joined.
//
// DEV vs PROD: `next dev` (Turbopack) evaluates client modules with `eval()` and opens an HMR websocket —
// both DEV-ONLY (React never uses `eval` in production). This app shipped WITHOUT that split while its
// sibling apps/web had one, so `next dev` served the production policy, eval was refused, and the dev
// client runtime never booted: React did not hydrate, no effect ran, the Turnstile script was never
// fetched, and the submit button sat on "Verifying you're human…" forever. It reads as a broken captcha,
// not as a CSP problem — the same misleading signature `next.config.ts` documents for allowedDevOrigins.
// Nothing caught it because nothing had ever opened this page in a browser; playwright/login.spec.ts now
// does. The PRODUCTION policy is unchanged: no eval, and the same origins in both modes.
function cspDirectives(dev: boolean): Record<string, readonly string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": dev
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN]
      : ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN],
    // GSI loads an EXTERNAL stylesheet (/gsi/style), which 'unsafe-inline' does not cover.
    "style-src": ["'self'", "'unsafe-inline'", GOOGLE_IDENTITY_ORIGIN],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    // Dev also allows the Turbopack HMR websocket. Schemes, not origins — the third-party origin
    // allowlist is identical in both modes, and a test pins that it stays that way.
    "connect-src": dev
      ? ["'self'", "ws:", "wss:", TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN]
      : ["'self'", TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN],
    // No 'self': neither third-party widget frames this origin, and adding it would only widen the
    // policy. Google's entry covers the LEGACY (non-FedCM) One Tap iframe — see GOOGLE_IDENTITY_ORIGIN.
    "frame-src": [TURNSTILE_ORIGIN, GOOGLE_IDENTITY_ORIGIN],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };
}

/**
 * Serialize the CSP directives into a `Content-Security-Policy` header value.
 *
 * Defaults to the PRODUCTION policy: a caller that forgets the flag gets the tight one, never the relaxed
 * one.
 */
export function buildContentSecurityPolicy(dev = false): string {
  return Object.entries(cspDirectives(dev))
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");
}

/**
 * The hardening headers, which are mode-independent — only the CSP differs between dev and production.
 */
const HARDENING: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // `identity-credentials-get` is what gates the FedCM prompt. It already defaults to `self` for a
  // top-level document, so this changes nothing today — it is pinned so a future tightening of this
  // header (or a stricter platform default) cannot silently disable One Tap with no failing test.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), identity-credentials-get=(self)",
  },
  // auth.webhook.co is a leaf host — no includeSubDomains/preload (sticky + hard to walk back; mirrors www).
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

/** Header name/value pairs for next.config `headers()` — applied to every auth response. */
export function securityHeaders(dev = false): ReadonlyArray<{ key: string; value: string }> {
  return [{ key: "Content-Security-Policy", value: buildContentSecurityPolicy(dev) }, ...HARDENING];
}

/**
 * The production header set.
 *
 * Retained as a named export because it is the shape the tests assert against and the shape every
 * non-dev response ships; `next.config.ts` calls {@link securityHeaders} so `next dev` can relax the CSP.
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> =
  securityHeaders(false);
