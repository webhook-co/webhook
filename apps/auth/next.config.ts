import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// auth.webhook.co deploys to Cloudflare Workers via @opennextjs/cloudflare (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

import { securityHeaders } from "./src/security-headers";

// `dev` ONLY relaxes the CSP (Turbopack evaluates client modules with eval() + opens an HMR websocket);
// every other field is mode-independent.
function buildNextConfig(dev: boolean): NextConfig {
  return {
    // @webhook-co/ui ships TS source → transpile it. @webhook-co/db + @webhook-co/shared are consumed as
    // built dist (via tsconfig paths) instead, so their Node/Workers crypto source isn't re-typechecked
    // under this app's DOM lib (the tsconfig-boundary friction); they must NOT be transpiled here.
    transpilePackages: ["@webhook-co/ui"],
    reactStrictMode: true,
    // `127.0.0.1` and `localhost` are the SAME server but different origins to Next, which blocks dev-asset
    // requests from an origin it wasn't started on. The failure is silent and badly misleading: the HTML and
    // the CSP arrive fine (curl sees a clean 200), but the client bundle is refused, so React never hydrates
    // — no effect runs, the Turnstile script is never fetched, and the magic-link submit sits on "Verifying
    // you're human…" forever. It reads as a broken captcha, not a host mismatch. The rest of the dev stack
    // pins 127.0.0.1 (`wrangler dev --ip 127.0.0.1`), so reaching for it here is the natural mistake.
    allowedDevOrigins: ["127.0.0.1"],
    // Externalize the auth-runtime + DB driver packages so OpenNext copies each FULL package and esbuild
    // resolves their exports under the "workerd" condition (rather than Next bundling them, which strands the
    // workerd-only files). @better-auth/core ships a workerd no-op `instrumentation` entry; pg-cloudflare is
    // pg's `cloudflare:sockets` adapter — both only resolve for the worker build when externalized here.
    // (@cloudflare/workers-oauth-provider is NOT here: it's imported only by src/worker.ts + ./issuer, the
    // wrangler-bundled layer, never by `next build` — wrangler externalizes its `cloudflare:workers` import.)
    serverExternalPackages: [
      "better-auth",
      "@better-auth/core",
      "@better-auth/api-key",
      "pg",
      "pg-cloudflare",
      "postgres",
    ],
    // Security headers for the auth UI (CSP + hardening) — applied to every Next-served response. See
    // src/security-headers.ts + docs/adr/0056-auth-csp.md.
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
