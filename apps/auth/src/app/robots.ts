import type { MetadataRoute } from "next";

// auth.webhook.co is a private-by-default product surface (login / consent / device) — never indexed.
// Disallow all crawling (a clean /robots.txt instead of the previous 404). This governs well-behaved
// crawlers; it does NOT stop the malicious vuln-scanner probes (those ignore robots.txt — they're
// already handled by 404s, and actively blocking them is a Cloudflare WAF / Bot Fight Mode concern).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
