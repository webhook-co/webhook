// Built-HTML SEO check. Runs against the *emitted* out/index.html after `next build`, so it
// asserts the actual shipped bytes (not the metadata object — that has its own unit test). This
// is the "OG missing / description too long" gate: structural problems are ERRORS (exit 1);
// authoring guidelines (title/description length, optional-but-recommended tags) are WARNINGS
// (printed, non-blocking — Google truncates by pixel width and rewrites these anyway).
//
// Plain Node + linkedom, no network, deterministic. Extend the rules as the site grows.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseHTML } from "linkedom";

// The expected canonical origin. Intentionally a literal (not imported from the TS metadata
// module — this runs as plain Node against the build output): it's the source of truth the check
// asserts the emitted URLs against, so a drift to the wrong host is caught.
const HOST = "https://www.webhook.co";
const htmlPath = fileURLToPath(new URL("../out/index.html", import.meta.url));

if (!existsSync(htmlPath)) {
  console.error(`✗ ${htmlPath} not found — run \`pnpm --filter @webhook-co/www build\` first.`);
  process.exit(1);
}

const rawHtml = readFileSync(htmlPath, "utf8");
const { document } = parseHTML(rawHtml);
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const attr = (sel, name = "content") => document.querySelector(sel)?.getAttribute(name) ?? null;
const stripSlash = (u) => (u && u !== "/" ? u.replace(/\/$/, "") : u);

// --- <title> -----------------------------------------------------------------
const titles = document.querySelectorAll("title");
if (titles.length !== 1) err(`expected exactly one <title>, found ${titles.length}`);
const title = titles[0]?.textContent?.trim() ?? "";
if (!title) err("<title> is empty");
else {
  if (!title.includes("webhook.co")) warn(`<title> does not mention the brand: "${title}"`);
  if (title.length < 30 || title.length > 60)
    warn(`<title> is ${title.length} chars (recommended 30–60): "${title}"`);
}

// --- meta description --------------------------------------------------------
const descEls = document.querySelectorAll('meta[name="description"]');
if (descEls.length !== 1) err(`expected exactly one meta description, found ${descEls.length}`);
const desc = descEls[0]?.getAttribute("content")?.trim() ?? "";
if (!desc) err("meta description is empty");
else if (desc.length < 70 || desc.length > 160)
  warn(`meta description is ${desc.length} chars (recommended 70–160)`);

// --- canonical ---------------------------------------------------------------
const canonicals = document.querySelectorAll('link[rel="canonical"]');
if (canonicals.length !== 1) err(`expected exactly one canonical link, found ${canonicals.length}`);
const canonical = canonicals[0]?.getAttribute("href") ?? "";
if (!canonical.startsWith(`${HOST}`))
  err(`canonical is not an absolute ${HOST} URL: "${canonical}"`);

// --- robots (never accidentally noindex) -------------------------------------
const robots = (attr('meta[name="robots"]') ?? "").toLowerCase();
if (robots.includes("noindex") || robots.includes("nofollow"))
  err(`robots meta blocks indexing in a production build: "${robots}"`);

// --- Open Graph --------------------------------------------------------------
const ogType = attr('meta[property="og:type"]');
const ogUrl = attr('meta[property="og:url"]');
const ogImage = attr('meta[property="og:image"]');
if (!attr('meta[property="og:title"]')) err("missing og:title");
if (ogType !== "website") err(`og:type should be "website", got "${ogType}"`);
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

// --- Twitter -----------------------------------------------------------------
const twCard = attr('meta[name="twitter:card"]');
if (twCard !== "summary_large_image")
  err(`twitter:card should be "summary_large_image", got "${twCard}"`);
if (!attr('meta[name="twitter:image"]')) warn("missing twitter:image (falls back to og:image)");

// --- document basics ---------------------------------------------------------
if (document.documentElement?.getAttribute("lang") !== "en")
  err('<html lang="en"> is missing/incorrect');
if (!document.querySelector('meta[name="viewport"]')) err("missing viewport meta");
// charset attribute matching is case-sensitive in linkedom (Next emits `charSet`), so test the
// raw bytes instead.
if (!/<meta\s+charset=/i.test(rawHtml)) warn("missing <meta charset>");

// --- JSON-LD -----------------------------------------------------------------
const ld = document.querySelector('script[type="application/ld+json"]')?.textContent ?? "";
if (!ld) err("missing JSON-LD structured data");
else {
  try {
    const parsed = JSON.parse(ld);
    const graph = parsed["@graph"];
    const nodes = Array.isArray(graph) ? graph : [parsed];
    const types = nodes.map((n) => n["@type"]);
    if (!types.includes("Organization")) err("JSON-LD is missing an Organization node");
    if (!types.includes("WebSite")) warn("JSON-LD is missing a WebSite node");
  } catch {
    err("JSON-LD does not parse as valid JSON");
  }
}

// --- in-page anchor integrity (#x must resolve to id="x") --------------------
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

// --- report ------------------------------------------------------------------
for (const w of warnings) console.warn(`⚠ ${w}`);
for (const e of errors) console.error(`✗ ${e}`);
if (errors.length) {
  console.error(`\nSEO check failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`✓ SEO check passed (${warnings.length} warning(s)).`);
