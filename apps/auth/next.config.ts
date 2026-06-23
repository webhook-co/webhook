import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// auth.webhook.co deploys to Cloudflare Workers via @opennextjs/cloudflare (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

import { SECURITY_HEADERS } from "./src/security-headers";

const nextConfig: NextConfig = {
  // @webhook-co/ui ships TS source → transpile it. @webhook-co/db + @webhook-co/shared are consumed as
  // built dist (via tsconfig paths) instead, so their Node/Workers crypto source isn't re-typechecked
  // under this app's DOM lib (the tsconfig-boundary friction); they must NOT be transpiled here.
  transpilePackages: ["@webhook-co/ui"],
  reactStrictMode: true,
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
    return [{ source: "/(.*)", headers: [...SECURITY_HEADERS] }];
  },
};

initOpenNextCloudflareForDev();

export default nextConfig;
