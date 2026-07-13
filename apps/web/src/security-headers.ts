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
 * form targets, and the script origin to `'self'`. The ONE cross-origin allowance is `connect-src`: the
 * live-events tail (ADR-0102) opens a WebSocket to the cookieless ingest apex (wbhk.my), a separate
 * registrable apex — so prod allowlists `'self'` + that apex's https/wss origins (derived from
 * INGEST_BASE_URL). Otherwise the dashboard loads NO third-party origin: no CDN, no analytics; the auth
 * handoff is a server-side service binding, never a browser fetch. A nonce/hash CSP is a follow-up gated on
 * a Workers nonce-injection story.
 *
 * DEV vs PROD: `next dev` (Turbopack) evaluates client modules with `eval()` and opens an HMR websocket —
 * both are DEV-ONLY (React never uses `eval` in production). Without `'unsafe-eval'` the dev client runtime
 * can't boot (client-side navigation blanks); without a broad `ws:`/`wss:` the HMR socket is blocked. So the
 * dev policy adds those; the PRODUCTION policy stays tight (no `eval`, and connect-src is pinned to the
 * ingest apex, never the scheme wildcards).
 */

/**
 * The ingest apex the dashboard's live-events tail connects a WebSocket to — the SAME committed apex the
 * endpoint ingest URL + `getListenWsUrl()` are built on (`INGEST_BASE_URL`, default `https://wbhk.my`).
 * Read from the BUILD env (this header is baked at `next build` time), so a self-host apex flows through
 * automatically and can't drift from the socket URL. Returns the https + wss origins to allowlist.
 */
function ingestConnectOrigins(): readonly string[] {
  const raw =
    process.env.INGEST_BASE_URL && process.env.INGEST_BASE_URL.length > 0
      ? process.env.INGEST_BASE_URL
      : "https://wbhk.my";
  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    host = "wbhk.my";
  }
  // Both schemes: the WebSocket connects over wss; the https origin covers a same-host probe/handshake.
  // (A scheme-less host would also match, but being explicit keeps the policy legible.)
  return [`https://${host}`, `wss://${host}`];
}

// Insertion order is the serialized order. Each value array is space-joined; directives are "; "-joined.
// Only directives that DIFFER from default-src are listed. `connect-src` is now explicit: the live-events
// tail (ADR-0102) opens a WebSocket to the cross-origin ingest apex (wbhk.my), which `default-src 'self'`
// would block — so prod allowlists `'self'` + the ingest apex's https/wss origins (dev keeps the broad
// ws:/wss: for the Turbopack HMR socket). Fetch directives with no cross-origin need (font-src, …) stay
// omitted and inherit default-src.
function cspDirectives(dev: boolean): Record<string, readonly string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": dev
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
      : ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    // The live-events WebSocket to the ingest apex; dev also allows the Turbopack HMR ws.
    "connect-src": dev ? ["'self'", "ws:", "wss:"] : ["'self'", ...ingestConnectOrigins()],
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

/**
 * The route patterns that render AUTHENTICATED HTML — everything the DAL gate stands in front of.
 *
 * Deliberately NOT `/(.*)`: that would also match `/_next/static/*`, and telling the browser not to store the
 * immutable, content-hashed JS/CSS bundles would be a large, self-inflicted performance regression.
 */
export const AUTHENTICATED_ROUTE_SOURCES: readonly string[] = [
  "/", // the post-login landing (resolves the default org, then redirects)
  "/org/:path*", // every org-scoped dashboard page
  "/invite/:path*", // invite acceptance — carries the inviting org's name
];

/**
 * `Cache-Control` for authenticated HTML: never store it, anywhere.
 *
 * Next ALREADY emits exactly this on these routes, because every one of them reads `cookies()` (via
 * `verifySession`) and a cookie-reading render is dynamic. So today this header changes nothing — which is
 * precisely why it is worth writing down.
 *
 * The problem with an invariant that holds only as an emergent side-effect is that nothing defends it. The
 * day someone adds `export const revalidate = 60` to a dashboard route for performance — an entirely
 * reasonable-looking change, and this repo is actively in a performance lane — that page silently becomes a
 * STORED response holding one tenant's org data, servable to whoever asks next. Nothing in CI would object.
 *
 * It used to have a backstop: `Clear-Site-Data: "cache"` on logout purged the whole registrable domain. That
 * header was removed because it was costing ~25 seconds of every logout (measured). So the invariant it was
 * quietly propping up needs to be true BY CONSTRUCTION now, and asserted, rather than inferred from a Next
 * default that no test pins.
 */
export function noStoreHeaders(): ReadonlyArray<{ key: string; value: string }> {
  return [{ key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" }];
}
