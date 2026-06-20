import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// auth.webhook.co deploys to Cloudflare Workers via @opennextjs/cloudflare (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // The design system ships as TypeScript source; let Next transpile it.
  transpilePackages: ["@webhook-co/ui", "@webhook-co/shared"],
  reactStrictMode: true,
  // The Better Auth runtime + the node-postgres driver use Node built-ins; keep them external so Next
  // resolves their server/workerd export path at runtime instead of trying to bundle them (A1b-1).
  serverExternalPackages: ["better-auth", "pg"],
};

initOpenNextCloudflareForDev();

export default nextConfig;
