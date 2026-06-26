/**
 * Security response headers for the app.webhook.co dashboard, wired into next.config.ts `headers()` so
 * OpenNext applies them to every Next-served response. See docs/adr/0077-web-dashboard-surface.md.
 *
 * This module intentionally mirrors apps/auth/src/security-headers.ts — the two differ only in third-party
 * origins (auth allowlists Cloudflare Turnstile; the dashboard allowlists none). Folding both (and apps/www's
 * _headers) onto one shared parameterized builder is a tracked follow-up, deliberately not done here to keep
 * this slice out of the co-owned apps/auth.
 *
 * CSP shape + the `'unsafe-inline'` tradeoff: OpenNext on Workers has no middleware (ADR-0021), so the
 * dashboard can't mint a per-request nonce — the same constraint apps/auth + apps/www document. Script and
 * style therefore fall back to `'unsafe-inline'` (Next's hydration injects inline `<script>`/`<style>`, the
 * shared theme-init script runs inline, and Radix injects inline styles). React's output-escaping stays the
 * primary XSS defense — load-bearing for the event payload-inspect view, which renders attacker-controlled
 * webhook bytes as escaped text; this CSP is defense-in-depth that locks down framing, base-uri, plugins,
 * form targets, and the connect/script origins to `'self'`. Unlike apps/auth (which allowlists Cloudflare
 * Turnstile), the dashboard loads NO third-party origin: it talks only to itself + same-origin server
 * actions, and the auth handoff is a server-side service binding, never a browser fetch. A nonce/hash CSP is
 * a follow-up gated on a Workers nonce-injection story.
 *
 * DEV vs PROD: `next dev` (Turbopack) evaluates client modules with `eval()` and opens an HMR websocket —
 * both are DEV-ONLY (React never uses `eval` in production). Without `'unsafe-eval'` the dev client runtime
 * can't boot (client-side navigation blanks); without `ws:` the HMR socket is blocked. So the dev policy
 * adds those two; the PRODUCTION policy stays tight (no `eval`, connect inherits `'self'`).
 */

// Insertion order is the serialized order. Each value array is space-joined; directives are "; "-joined.
// Only directives that DIFFER from default-src are listed: fetch directives that would merely restate
// `default-src 'self'` (connect-src, font-src, …) are omitted and inherit it. Add an explicit directive
// when a real cross-origin need lands — an OAuth avatar CDN on img-src if a view renders `user.image` (the
// session carries it; the account menu shows initials today).
function cspDirectives(dev: boolean): Record<string, readonly string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": dev
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
      : ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    // Dev only: the Turbopack HMR websocket (prod inherits default-src 'self').
    ...(dev ? { "connect-src": ["'self'", "ws:", "wss:"] } : {}),
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };
}

/** Serialize the CSP directives into a `Content-Security-Policy` header value (prod policy by default). */
export function buildContentSecurityPolicy(dev = false): string {
  return Object.entries(cspDirectives(dev))
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");
}

/** Header name/value pairs for next.config `headers()` — applied to every dashboard response. */
export function securityHeaders(dev = false): ReadonlyArray<{ key: string; value: string }> {
  return [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(dev) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    // app.webhook.co is a leaf host — no includeSubDomains/preload (sticky + hard to walk back; mirrors auth/www).
    { key: "Strict-Transport-Security", value: "max-age=63072000" },
  ];
}
