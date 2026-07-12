// Built-HTML SEO check. Runs against the *emitted* out/*.html after `next build`, so it asserts the
// actual shipped bytes (not the metadata object — that has its own unit test). This is the "OG
// missing / description too long / canonical drift" gate: structural problems are ERRORS (exit 1);
// authoring guidelines (title/description length, optional-but-recommended tags) are WARNINGS
// (printed, non-blocking — Google truncates by pixel width and rewrites these anyway).
//
// It is ROUTE-AWARE: rather than inspecting only out/index.html, it reads the emitted out/sitemap.xml
// (itself derived from the route manifest in src/lib/routes.ts) and runs the head checks on EVERY
// listed page. Add a route to the manifest → it lands in the sitemap → it's SEO-gated here, with no
// edit to this file. Before this, a new page shipped with zero SEO coverage and nothing turned red.
//
// Plain Node + linkedom, no network, deterministic. The pure helpers are exported so they can be
// unit-tested against fixtures without a full build (see check-seo-html.test.mjs).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseHTML } from "linkedom";

// The expected canonical origin. Intentionally a literal (not imported from the TS metadata module —
// this runs as plain Node against the build output): it's the source of truth the check asserts the
// emitted URLs against, so a drift to the wrong host is caught.
export const HOST = "https://www.webhook.co";

const stripSlash = (u) => (u && u !== "/" ? u.replace(/\/$/, "") : u);

/** Every `<loc>` in a sitemap.xml, in document order. Pure, so it's testable without a build. */
export function extractSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

/**
 * True when this module was executed directly (not imported). Robust against the two traps that a
 * naive `import.meta.url === "file://" + process.argv[1]` comparison falls into: Node realpaths the
 * module URL but NOT argv[1] (so a symlinked checkout — /tmp→/private/tmp — makes them diverge and
 * the check silently no-ops), and a bare `file://` concat mis-encodes spaces/special chars in the
 * path. `realpathSync` + `pathToFileURL` handle both. This gate is required in CI; it must never
 * exit 0 having inspected nothing.
 */
export function isMainModule(moduleUrl, argv1) {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
}

/**
 * Map a canonical page URL to the static-export file that should hold it, relative to out/.
 * Next's `output: "export"` (no trailingSlash) emits FLAT files: `/` → "index.html",
 * `/pricing` → "pricing.html", `/product/verification` → "product/verification.html". Pure.
 */
export function pageFileForUrl(url, host = HOST) {
  // Defensive: a caller writing `locs.map(pageFileForUrl)` passes the array index as `host`. A
  // non-string host would silently defeat the strip below, so fall back to the default.
  if (typeof host !== "string") host = HOST;
  const path = stripSlash(url.startsWith(host) ? url.slice(host.length) : url) || "/";
  return path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`;
}

/**
 * Run the SEO head rules against one page's emitted HTML. Returns { errors, warnings }.
 *
 * @param html      the emitted document
 * @param opts.url  the canonical URL this page is expected to advertise (its sitemap loc)
 * @param opts.host the canonical origin
 * @param opts.requireOrgLd  whether Organization+WebSite JSON-LD is REQUIRED (home page only) vs.
 *                           merely "must parse if present" (inner pages).
 */
export function checkPage(html, { url, host = HOST, requireOrgLd = false } = {}) {
  const { document } = parseHTML(html);
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const attr = (sel, name = "content") => document.querySelector(sel)?.getAttribute(name) ?? null;

  // --- <title> ---------------------------------------------------------------
  const titles = document.querySelectorAll("title");
  if (titles.length !== 1) err(`expected exactly one <title>, found ${titles.length}`);
  const title = titles[0]?.textContent?.trim() ?? "";
  if (!title) err("<title> is empty");
  else {
    if (!title.includes("webhook.co")) warn(`<title> does not mention the brand: "${title}"`);
    if (title.length < 30 || title.length > 60)
      warn(`<title> is ${title.length} chars (recommended 30–60): "${title}"`);
  }

  // --- meta description ------------------------------------------------------
  const descEls = document.querySelectorAll('meta[name="description"]');
  if (descEls.length !== 1) err(`expected exactly one meta description, found ${descEls.length}`);
  const desc = descEls[0]?.getAttribute("content")?.trim() ?? "";
  if (!desc) err("meta description is empty");
  else if (desc.length < 70 || desc.length > 160)
    warn(`meta description is ${desc.length} chars (recommended 70–160)`);

  // --- canonical -------------------------------------------------------------
  const canonicals = document.querySelectorAll('link[rel="canonical"]');
  if (canonicals.length !== 1)
    err(`expected exactly one canonical link, found ${canonicals.length}`);
  const canonical = canonicals[0]?.getAttribute("href") ?? "";
  if (!canonical.startsWith(host)) err(`canonical is not an absolute ${host} URL: "${canonical}"`);
  // Route-aware: the canonical must match THIS page's sitemap URL, not just "some www URL". A page
  // that canonicalises to the homepage (a classic static-export metadata bug) is caught here.
  if (url && stripSlash(canonical) !== stripSlash(url))
    err(`canonical (${canonical}) does not match this page's URL (${url})`);

  // --- robots (never accidentally noindex) -----------------------------------
  const robots = (attr('meta[name="robots"]') ?? "").toLowerCase();
  if (robots.includes("noindex") || robots.includes("nofollow"))
    err(`robots meta blocks indexing in a production build: "${robots}"`);

  // --- Open Graph ------------------------------------------------------------
  const ogType = attr('meta[property="og:type"]');
  const ogUrl = attr('meta[property="og:url"]');
  const ogImage = attr('meta[property="og:image"]');
  if (!attr('meta[property="og:title"]')) err("missing og:title");
  // og:type must be a valid object type — but NOT hardcoded to "website". A future long-form page may
  // legitimately be "article" (set via pageMetadata's ogType arg), so the gate accepts either rather
  // than hard-erroring the way the original single-page check did.
  if (!ogType) err("missing og:type");
  else if (!["website", "article"].includes(ogType))
    err(`og:type is "${ogType}" — expected website or article`);
  if (!ogUrl) err("missing og:url");
  else if (stripSlash(ogUrl) !== stripSlash(canonical))
    err(`og:url (${ogUrl}) does not match canonical (${canonical})`);
  if (!ogImage) err("missing og:image (the social card)");
  else if (!/^https?:\/\//.test(ogImage)) err(`og:image must be absolute, got "${ogImage}"`);
  if (!attr('meta[property="og:description"]')) warn("missing og:description");
  if (!attr('meta[property="og:site_name"]')) warn("missing og:site_name");
  if (!attr('meta[property="og:image:alt"]')) warn("missing og:image:alt");
  const ogW = attr('meta[property="og:image:width"]');
  const ogH = attr('meta[property="og:image:height"]');
  if (ogW !== "1200" || ogH !== "630")
    warn(`og:image dimensions are ${ogW}×${ogH} (recommended 1200×630)`);

  // --- Twitter ---------------------------------------------------------------
  const twCard = attr('meta[name="twitter:card"]');
  if (twCard !== "summary_large_image")
    err(`twitter:card should be "summary_large_image", got "${twCard}"`);
  if (!attr('meta[name="twitter:image"]')) warn("missing twitter:image (falls back to og:image)");

  // --- document basics -------------------------------------------------------
  if (document.documentElement?.getAttribute("lang") !== "en")
    err('<html lang="en"> is missing/incorrect');
  if (!document.querySelector('meta[name="viewport"]')) err("missing viewport meta");
  // charset attribute matching is case-sensitive in linkedom (Next emits `charSet`), so test the raw
  // bytes instead.
  if (!/<meta\s+charset=/i.test(html)) warn("missing <meta charset>");

  // --- JSON-LD ---------------------------------------------------------------
  const ldEl = document.querySelector('script[type="application/ld+json"]');
  const ld = ldEl?.textContent ?? "";
  if (requireOrgLd) {
    if (!ld) err("missing JSON-LD structured data");
    else {
      try {
        const parsed = JSON.parse(ld);
        const graph = parsed["@graph"];
        const nodes = Array.isArray(graph) ? graph : [parsed];
        const types = nodes.flatMap((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]));
        if (!types.includes("Organization")) err("JSON-LD is missing an Organization node");
        if (!types.includes("WebSite")) warn("JSON-LD is missing a WebSite node");
      } catch {
        err("JSON-LD does not parse as valid JSON");
      }
    }
  } else if (ld) {
    // Inner pages don't have to carry the Organization graph, but any JSON-LD they DO ship must be
    // valid — a malformed blob is a rich-result own-goal.
    try {
      JSON.parse(ld);
    } catch {
      err("JSON-LD does not parse as valid JSON");
    }
  }

  // --- in-page anchor integrity (#x must resolve to id="x") ------------------
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const href = a.getAttribute("href");
    if (!href || href === "#") continue;
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      err(`anchor ${href} has a malformed fragment`);
      continue;
    }
    if (!document.getElementById(id)) err(`anchor ${href} has no matching id="${id}"`);
  }

  return { errors, warnings };
}

// Only sweep the build output when RUN as a script, so the pure helpers above stay importable from a
// test without walking out/ and calling process.exit().
if (isMainModule(import.meta.url, process.argv[1])) {
  const outDir = fileURLToPath(new URL("../out/", import.meta.url));
  const sitemapPath = join(outDir, "sitemap.xml");

  if (!existsSync(sitemapPath)) {
    console.error(
      `✗ ${sitemapPath} not found — run \`pnpm --filter @webhook-co/www build\` first.`,
    );
    process.exit(1);
  }

  const locs = extractSitemapLocs(readFileSync(sitemapPath, "utf8"));
  // A guard on the guard: an empty sitemap would let this pass vacuously ("checked 0 pages").
  if (locs.length === 0) {
    console.error(`✗ ${sitemapPath} lists no <loc> — refusing to pass vacuously.`);
    process.exit(1);
  }

  const allErrors = [];
  let warningCount = 0;
  for (const url of locs) {
    const rel = pageFileForUrl(url);
    const file = join(outDir, rel);
    if (!existsSync(file)) {
      allErrors.push(`${rel}: sitemap advertises ${url} but out/${rel} was not emitted`);
      continue;
    }
    const isHome = stripSlash(url) === stripSlash(HOST);
    const { errors, warnings } = checkPage(readFileSync(file, "utf8"), {
      url,
      host: HOST,
      requireOrgLd: isHome,
    });
    for (const w of warnings) console.warn(`⚠ ${rel}: ${w}`);
    warningCount += warnings.length;
    for (const e of errors) allErrors.push(`${rel}: ${e}`);
  }

  for (const e of allErrors) console.error(`✗ ${e}`);
  if (allErrors.length) {
    console.error(
      `\nSEO check failed: ${allErrors.length} error(s), ${warningCount} warning(s) across ${locs.length} page(s).`,
    );
    process.exit(1);
  }
  console.log(`✓ SEO check passed — ${locs.length} page(s), ${warningCount} warning(s).`);
}
