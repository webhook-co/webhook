import type { NextConfig } from "next";
// Wire the OpenNext Cloudflare dev hook so `next dev` exposes the Worker bindings (no-op at build).
// auth.webhook.co deploys to Cloudflare Workers via @opennextjs/cloudflare (open-next.config.ts).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // @webhook-co/ui ships TS source → transpile it. @webhook-co/db + @webhook-co/shared are consumed as
  // built dist (via tsconfig paths) instead, so their Node/Workers crypto source isn't re-typechecked
  // under this app's DOM lib (the tsconfig-boundary friction); they must NOT be transpiled here.
  transpilePackages: ["@webhook-co/ui"],
  reactStrictMode: true,
  // The Better Auth runtime + the node-postgres / postgres.js drivers use Node built-ins; keep them
  // external so Next resolves their server/workerd export path at runtime instead of bundling them.
  serverExternalPackages: ["better-auth", "pg", "postgres"],
};

initOpenNextCloudflareForDev();

export default nextConfig;
