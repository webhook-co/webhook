import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// The dashboard deploys to Cloudflare Workers via `@opennextjs/cloudflare` (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

import { securityHeaders } from "./src/security-headers";

// `dev` ONLY relaxes the CSP (Turbopack evaluates client modules with eval() + opens an HMR websocket);
// every other field is mode-independent.
function buildNextConfig(dev: boolean): NextConfig {
  return {
    // These workspace packages ship as TypeScript source; let Next transpile them. `@webhook-co/contract`/
    // `@webhook-co/db` are consumed only by SERVER modules (the credential actions + the gated reads); the
    // client manager takes its data as props, so neither registry enters a browser bundle. `@webhook-co/db`
    // is imported via leaf subpaths (e.g. `@webhook-co/db/api-keys`) — its `export *` barrel resolves to
    // `undefined` under Turbopack (see `@webhook-co/contract`'s index note).
    transpilePackages: [
      "@webhook-co/ui",
      "@webhook-co/shared",
      "@webhook-co/contract",
      "@webhook-co/db",
    ],
    // The Postgres driver is a real npm package with a workerd export path — externalize it so Next/Turbopack
    // doesn't bundle its Node build into the Worker (E8b wires the tenant DB client over Hyperdrive).
    serverExternalPackages: ["postgres"],
    // Linting is owned by the repo-wide ESLint gate (`pnpm lint`); Next 16 no longer
    // runs lint at build time, so there is exactly one lint authority.
    reactStrictMode: true,
    // Security response headers (CSP + hardening) — applied to every Next-served response. OpenNext on
    // Workers has no middleware/nonce, so script/style fall back to 'unsafe-inline' (Next hydration + the
    // theme-init script + Radix inline styles); React's output-escaping stays the primary XSS defense (load-
    // bearing for the event payload-inspect view, which renders attacker-controlled bytes as escaped text).
    // See src/security-headers.ts + docs/adr/0077-web-dashboard-surface.md. This does NOT set
    // serverActions.allowedOrigins — Next's same-origin server-action check stays the CSRF guard, pinned by
    // next-config-csrf.test.ts.
    async headers() {
      return [{ source: "/(.*)", headers: [...securityHeaders(dev)] }];
    },
  };
}

initOpenNextCloudflareForDev();

// Next invokes the default export with the build PHASE. `PHASE_DEVELOPMENT_SERVER` is passed ONLY by
// `next dev` — a build-time constant from Next, NOT a runtime env var a misconfigured CI could leave
// unset/"development" — so the CSP relaxation ('unsafe-eval' + the HMR websocket) is fail-CLOSED: every
// `next build` / deploy runs a non-dev phase and ships the tight production policy regardless of NODE_ENV.
export default function nextConfig(phase: string): NextConfig {
  return buildNextConfig(phase === PHASE_DEVELOPMENT_SERVER);
}
