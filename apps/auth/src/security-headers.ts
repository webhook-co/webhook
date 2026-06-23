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
const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'", TURNSTILE_ORIGIN],
  "frame-src": [TURNSTILE_ORIGIN],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
};

/** Serialize {@link CSP_DIRECTIVES} into a `Content-Security-Policy` header value. */
export function buildContentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");
}

/** Header name/value pairs for next.config `headers()` — applied to every auth response. */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Content-Security-Policy", value: buildContentSecurityPolicy() },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // auth.webhook.co is a leaf host — no includeSubDomains/preload (sticky + hard to walk back; mirrors www).
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];
