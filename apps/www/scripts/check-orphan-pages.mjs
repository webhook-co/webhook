#!/usr/bin/env node
// Post-build guard: no indexable page is an ORPHAN — every one is linked from at least one other page.
//
// This exists because sixteen pages shipped unreachable with a completely green CI. The `/test/<slug>`
// tutorials were in the route manifest, so they were sitemapped, SEO-checked, axe-scanned and
// export-verified — four gates, all passing, none of which can answer the only question that decides
// whether the pages have an audience: *can you get there from here?* A visitor could reach one only
// from a search result or by typing the URL, and a crawler treats a sitemap-only page as an orphan
// no matter how good it is.
//
// So the check is deliberately about the emitted link GRAPH rather than about any manifest: it reads
// out/, follows the `<a href>`s a visitor actually gets, and fails when a sitemapped route has no
// inbound link from a different page. Self-links don't count — a breadcrumb pointing at its own page
// is not a way in.
//
// Scope note: `/play` is intentionally NOT in the sitemap (it's a noindex sandbox), so it is not
// gated here. This checks what we ask search engines to index.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { htmlFiles } from "./check-no-dead-links.mjs";
import { extractSitemapLocs, HOST, isMainModule } from "./check-seo-html.mjs";

/**
 * Any `<a>` with a site-absolute href. `[^>]+` (a negated class, not `.`) spans the newlines prettier
 * puts between attributes, so attribute ORDER can't hide a link from the graph. All HTML in out/ is
 * React-emitted, so double-quoted lowercase attributes are the only form that occurs.
 */
const INTERNAL_HREF = /<a[^>]+href="(\/[^"]*)"/g;

/** One destination, one identity: query, hash and a trailing slash are not different pages. */
export function normalizePath(href) {
  const path = href.split("#")[0].split("?")[0];
  if (path === "" || path === "/") return "/";
  return path.replace(/\/+$/, "");
}

/** Every distinct site-absolute destination a document links to, in document order. */
export function internalLinks(html) {
  const seen = [];
  for (const [, href] of html.matchAll(INTERNAL_HREF)) {
    const path = normalizePath(href);
    if (!seen.includes(path)) seen.push(path);
  }
  return seen;
}

/**
 * How many DISTINCT other pages link to each destination.
 *
 * Two deliberate choices, both about not letting a page look reachable when it isn't:
 *  - a self-link is skipped, because a breadcrumb or canonical pointing at its own page is not a
 *    route in;
 *  - repeats within one page count once, so a nav rendered twice (desktop + mobile markup) doesn't
 *    inflate a destination's apparent support.
 *
 * @param {{path: string, html: string}[]} pages
 */
export function inboundCounts(pages) {
  const counts = new Map();
  for (const page of pages) {
    const from = normalizePath(page.path);
    for (const to of internalLinks(page.html)) {
      if (to === from) continue;
      counts.set(to, (counts.get(to) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The sitemapped routes that nothing links to. The homepage is exempt: it is the site root, reachable
 * by definition and by every wordmark.
 *
 * Throws on an empty route list rather than returning `[]`. "No routes to check" and "no orphans
 * found" are the same value otherwise, and reporting success for work never done is precisely the
 * failure mode this guard was written to catch.
 */
export function findOrphans(routePaths, counts) {
  if (routePaths.length === 0) {
    throw new Error("check-orphan-pages: no routes to check — refusing to pass vacuously.");
  }
  return routePaths
    .map(normalizePath)
    .filter((path) => path !== "/" && (counts.get(path) ?? 0) === 0);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const OUT = fileURLToPath(new URL("../out/", import.meta.url));
  const sitemapPath = join(OUT, "sitemap.xml");

  if (!existsSync(sitemapPath)) {
    console.error(
      `✗ ${sitemapPath} not found — run \`pnpm --filter @webhook-co/www build\` first.`,
    );
    process.exit(1);
  }

  const routes = extractSitemapLocs(readFileSync(sitemapPath, "utf8")).map((url) =>
    normalizePath(url.startsWith(HOST) ? url.slice(HOST.length) || "/" : url),
  );

  const files = htmlFiles(OUT);
  if (files.length === 0) {
    console.error(`✗ ${OUT} contains no .html — the build emitted nothing. Refusing to pass.`);
    process.exit(1);
  }

  const pages = files.map((file) => ({
    // out/test/stripe.html and out/test/stripe/index.html both serve /test/stripe.
    path: `/${file.replace(/(?:\/?index)?\.html$/, "")}`,
    html: readFileSync(join(OUT, file), "utf8"),
  }));

  let orphans;
  try {
    orphans = findOrphans(routes, inboundCounts(pages));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }

  if (orphans.length > 0) {
    console.error("✖ Indexable pages nothing links to:\n");
    for (const path of orphans) console.error(`  ${path}`);
    console.error(
      "\nA sitemap entry is not discoverability. Link each of these from a page a visitor actually\n" +
        "reaches — a hub, the nav (src/components/marketing/nav-links.ts), the footer, or contextual\n" +
        "prose. If a page is genuinely not meant to be found, take it out of the sitemap instead\n" +
        "(sitemap: false in src/lib/routes.ts), the way /play is.",
    );
    process.exit(1);
  }

  console.log(`✔ No orphan pages — ${routes.length} indexable routes, all linked.`);
}
