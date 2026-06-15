import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static marketing site: `next build` emits an `out/` folder of plain assets that
  // any static host serves. The site uses no server runtime (no SSR/ISR/route handlers),
  // so a static export is the right artifact — it's deployed to Cloudflare Workers Static Assets.
  output: "export",
  // Static export has no image-optimization server; the site is monochrome + SVG, so this
  // is a non-loss (we ship no raster images through next/image).
  images: { unoptimized: true },
  // The design system ships as TypeScript source; let Next transpile it.
  transpilePackages: ["@webhook-co/ui"],
  // Linting is owned by the repo-wide ESLint gate (`pnpm lint`); Next 16 no longer
  // runs lint at build time, so there is exactly one lint authority.
  reactStrictMode: true,
};

export default nextConfig;
