import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The design system ships as TypeScript source; let Next transpile it.
  transpilePackages: ["@webhook-co/ui", "@webhook-co/shared"],
  // Linting is owned by the repo-wide ESLint gate (`pnpm lint`); Next 16 no longer
  // runs lint at build time, so there is exactly one lint authority.
  reactStrictMode: true,
};

export default nextConfig;
