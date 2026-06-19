import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// The dashboard deploys to Cloudflare Workers via `@opennextjs/cloudflare` (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // The design system ships as TypeScript source; let Next transpile it.
  transpilePackages: ["@webhook-co/ui", "@webhook-co/shared"],
  // Linting is owned by the repo-wide ESLint gate (`pnpm lint`); Next 16 no longer
  // runs lint at build time, so there is exactly one lint authority.
  reactStrictMode: true,
};

// E6/E7 add `serverExternalPackages: ["jose", "postgres"]` here when the session JWT + the Postgres
// driver are imported, so Next bundles their workerd export path rather than the Node one.
initOpenNextCloudflareForDev();

export default nextConfig;
