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

/** The only third-party origin the auth UI loads: Cloudflare Turnstile (the login captcha). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

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
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", TURNSTILE_ORIGIN]
      : ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    // Dev also allows the Turbopack HMR websocket. Schemes, not origins — the third-party origin
    // allowlist is identical in both modes, and a test pins that it stays that way.
    "connect-src": dev ? ["'self'", "ws:", "wss:", TURNSTILE_ORIGIN] : ["'self'", TURNSTILE_ORIGIN],
    "frame-src": [TURNSTILE_ORIGIN],
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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
