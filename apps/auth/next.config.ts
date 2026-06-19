import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// auth.webhook.co deploys to Cloudflare Workers via @opennextjs/cloudflare (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // The design system ships as TypeScript source; let Next transpile it.
  transpilePackages: ["@webhook-co/ui", "@webhook-co/shared"],
  reactStrictMode: true,
};

// Lane C adds `serverExternalPackages` (e.g. the better-auth runtime / PG driver / jose) here when the
// runtime auth Worker imports them, so Next bundles their workerd export path rather than the Node one.
initOpenNextCloudflareForDev();

export default nextConfig;
