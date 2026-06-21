import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// The dashboard deploys to Cloudflare Workers via `@opennextjs/cloudflare` (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
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
};

initOpenNextCloudflareForDev();

export default nextConfig;
