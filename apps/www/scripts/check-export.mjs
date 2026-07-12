// Post-build guard for the static export. Run after `next build` (output: "export"): it asserts the
// artifacts the Cloudflare deploy depends on actually made it into out/, so a broken export fails
// BEFORE it ships, not after. The a11y/Lighthouse jobs serve out/ without applying _headers, so the
// header behaviours below are invisible to them — this is the one place we check them in CI.
//
// It is ROUTE-AWARE: the fixed infra files below are joined with the per-page HTML derived from the
// emitted out/sitemap.xml (itself built from the route manifest). So a route added to the manifest
// that fails to emit its page is caught here, not discovered live.
//
// Runnable locally via `pnpm --filter @webhook-co/www check:export`; wired into the deploy workflow.
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { extractSitemapLocs, pageFileForUrl } from "./check-seo-html.mjs";

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
const failures = [];

// Infra files the host needs regardless of page count: the homepage, the custom 404
// (not_found_handling: "404-page"), the headers file, the SEO routes, and the social card.
// index.html is listed UNCONDITIONALLY (not only when "/" appears in the sitemap) — a homepage that
// opted out of the sitemap would still have to exist, and "/" 404ing is the worst failure to miss.
const infra = ["index.html", "404.html", "_headers", "sitemap.xml", "robots.txt", "og.png"];

// Every page the sitemap advertises must have actually been emitted.
let pageFiles = [];
try {
  const sitemap = await readFile(outDir + "sitemap.xml", "utf8");
  const locs = extractSitemapLocs(sitemap);
  if (locs.length === 0) failures.push("out/sitemap.xml lists no <loc> — export emitted no pages");
  // Not `locs.map(pageFileForUrl)` — map passes (element, index), and the index would land in
  // pageFileForUrl's `host` param, defeating the host-strip. Call it with the URL only.
  pageFiles = locs.map((loc) => pageFileForUrl(loc));
} catch {
  failures.push("could not read out/sitemap.xml to derive the required page list");
}

// Dedupe: index.html is in `infra` unconditionally AND is the "/" route's derived pageFile, so it
// would otherwise be checked twice.
const required = [...new Set([...infra, ...pageFiles])];
for (const rel of required) {
  try {
    await access(outDir + rel);
  } catch {
    failures.push(`missing out/${rel}`);
  }
}

// Spot-check the two header behaviours that have bitten us before: the immutable cache rule scoped
// to the content-hashed assets, and the CSP/HSTS that the static host can't add any other way.
try {
  const headers = await readFile(outDir + "_headers", "utf8");
  if (!/\/_next\/static\/\*/.test(headers) || !/immutable/.test(headers)) {
    failures.push("out/_headers is missing the immutable /_next/static/* cache rule");
  }
  // Assert the CSP keeps script-src 'unsafe-inline' — narrowing it to a bare 'self' returns 200 but
  // silently breaks Next's inline hydration, which no other CI job would catch.
  if (!/Content-Security-Policy:[^\n]*script-src[^;]*'unsafe-inline'/i.test(headers)) {
    failures.push("out/_headers CSP is missing or its script-src dropped 'unsafe-inline'");
  }
  if (!/Strict-Transport-Security:/i.test(headers)) {
    failures.push("out/_headers is missing Strict-Transport-Security");
  }
} catch {
  failures.push("could not read out/_headers");
}

if (failures.length > 0) {
  console.error("check:export failed:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log(`check:export ok — verified ${required.length} artifacts + header rules in out/`);
