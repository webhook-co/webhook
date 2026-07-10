import type { MetadataRoute } from "next";

import { SITE_URL } from "./metadata";

// Under `output: 'export'` Next emits this to out/sitemap.xml at build. Bump LAST_MODIFIED by hand on
// substantive changes. It's a fixed constant on purpose — a `new Date()` would churn the emitted bytes every
// build and defeat the built-HTML SEO check.
//
// Every route in app/ that a human should be able to find belongs here. A pricing page missing from the
// sitemap is a pricing page search engines have to stumble onto.
const LAST_MODIFIED = "2026-07-10";

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
    {
      url: `${SITE_URL}/pricing`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/sub-processors`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
