import type { MetadataRoute } from "next";

import { SITE_URL } from "./metadata";

// Under `output: 'export'` Next emits this to out/sitemap.xml at build. One page today; bump
// LAST_MODIFIED by hand on substantive homepage changes. It's a fixed constant on purpose — a
// `new Date()` would churn the emitted bytes every build and defeat the built-HTML SEO check.
const LAST_MODIFIED = "2026-06-17";

// Opt the metadata route into static rendering so it's emitted as a file under `output: 'export'`.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
