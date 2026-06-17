import type { MetadataRoute } from "next";

import { SITE_URL } from "./metadata";

// Under `output: 'export'` Next emits this to out/robots.txt at build; the route must opt into
// static rendering explicitly.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  // No `host` directive: it's a non-standard, Yandex-only field (Google ignores it) and host
  // canonicalization is handled by the apex→www 301 + the canonical link, not robots.txt.
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
