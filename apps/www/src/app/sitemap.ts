import type { MetadataRoute } from "next";

import { SITEMAP_LAST_MODIFIED, sitemapRoutes } from "@/lib/routes";
import { absoluteUrl } from "./metadata";

// Under `output: 'export'` Next emits this to out/sitemap.xml at build. The route list is DERIVED
// from the manifest in `@/lib/routes` — add a page there and it appears here (and in the SEO/export
// gates that read this file back) automatically. A pricing page missing from the sitemap is a
// pricing page search engines have to stumble onto, so the manifest is the one place to forget.
//
// `lastModified` is a fixed constant (SITEMAP_LAST_MODIFIED), not `new Date()`: a per-build date
// would churn the emitted bytes every build and defeat the built-HTML SEO check.

// Opt the metadata route into static rendering so it's emitted as a file under `output: 'export'`.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapRoutes().map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: SITEMAP_LAST_MODIFIED,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
