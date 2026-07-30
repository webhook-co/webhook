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
  transpilePackages: [
    "@webhook-co/ui",
    "@webhook-co/webhooks-spec",
    "@webhook-co/webhooks-recipes",
  ],
  // Linting is owned by the repo-wide ESLint gate (`pnpm lint`); Next 16 no longer
  // runs lint at build time, so there is exactly one lint authority.
  reactStrictMode: true,
  // Same server, different ORIGIN as far as Next is concerned — without this it refuses the dev-asset
  // requests and React never hydrates, while curl still sees a clean 200. See apps/auth/next.config.ts.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
