#!/usr/bin/env node
// Read-only Google Search Console INDEXATION-COVERAGE reader. The ranking reader
// (gsc-provider-ranking.mjs) answers "do the pages that ARE indexed rank?"; this one answers the
// question that gates it: "which of our sitemapped URLs has Google actually indexed, and which is it
// declining or has never seen?" — the falsifiable instrument behind the "re-check on date X" items in
// the SEO-indexation diagnosis (internal/marketing/seo-indexation-diagnosis.md).
//
// It reads three read-only Search Console surfaces:
//   1. Sitemaps API      — GET /webmasters/v3/sites/{site}/sitemaps  (submitted/downloaded/pending)
//   2. the live sitemaps — to enumerate the URLs we claim to publish
//   3. URL Inspection    — POST /v1/urlInspection/index:inspect       (per-URL coverageState)
// and buckets every URL into indexed / crawled-not-indexed / discovered-not-indexed / unknown /
// redirect / other. The bucket distribution is the metric to watch over time.
//
// Auth is REUSED verbatim from gsc-provider-ranking.mjs (service-account JWT, token endpoint pinned,
// credential never printed). Pure helpers (parsing/classification/summary) are exported and unit-tested
// WITHOUT network; the fetches take an injectable fetchImpl so tests never touch Google.

import { getAccessToken, loadServiceAccount, SITE_URL } from "./gsc-provider-ranking.mjs";
import { isMain } from "./lib/docs-lib.mjs";

const WMX_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// The live sitemaps we enumerate URLs from. Both are covered by the sc-domain:webhook.co property.
export const SITEMAP_URLS = [
  "https://www.webhook.co/sitemap.xml",
  "https://docs.webhook.co/sitemap.xml",
];

// The buckets, in report order. Every run prints all of them (zeros included) so a distribution is
// never a silent gap. Keys mirror the GSC coverageState taxonomy, collapsed to what we act on.
export const BUCKETS = [
  "indexed",
  "crawled-not-indexed",
  "discovered-not-indexed",
  "unknown",
  "redirect",
  "other",
];

// GSC coverageState strings → our buckets. Anything not listed is "other" (e.g. duplicate/canonical
// states we don't separately act on). The strings are Google's exact UI/API wording.
const COVERAGE_MAP = new Map([
  ["Submitted and indexed", "indexed"],
  ["Indexed, not submitted in sitemap", "indexed"],
  ["Crawled - currently not indexed", "crawled-not-indexed"],
  ["Discovered - currently not indexed", "discovered-not-indexed"],
  ["URL is unknown to Google", "unknown"],
  ["Page with redirect", "redirect"],
]);

/** Extract every `<loc>` URL from a sitemap XML document (pure; trims surrounding whitespace). */
export function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>([\s\S]*?)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1].trim();
    if (url) locs.push(url);
  }
  return locs;
}

/** Map a GSC coverageState string to one of BUCKETS (pure). Missing/unknown → "other". */
export function classifyCoverage(coverageState) {
  return COVERAGE_MAP.get(coverageState) ?? "other";
}

/** Tally an array of bucket names into a record keyed by every declared bucket (zeros included). */
export function bucketCounts(buckets) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const b of buckets) counts[b] = (counts[b] ?? 0) + 1;
  return counts;
}

/** Flatten the Sitemaps API response into a report-friendly row per sitemap (pure). */
export function summarizeSitemaps(apiResponse) {
  const list = apiResponse?.sitemap ?? [];
  return list.map((s) => {
    const web = (s.contents ?? []).find((c) => c.type === "web") ?? s.contents?.[0];
    return {
      path: s.path,
      lastSubmitted: s.lastSubmitted,
      lastDownloaded: s.lastDownloaded,
      everDownloaded: Boolean(s.lastDownloaded),
      pending: Boolean(s.isPending),
      submittedUrls: web ? Number(web.submitted ?? 0) : 0,
      indexedUrls: web ? Number(web.indexed ?? 0) : 0,
    };
  });
}

/** GET the submitted-sitemaps list for the property. */
export async function fetchSitemapsList(token, { fetchImpl = fetch, siteUrl = SITE_URL } = {}) {
  const res = await fetchImpl(`${WMX_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (json.error) throw new Error(`GSC sitemaps list failed: ${JSON.stringify(json.error)}`);
  return json;
}

/** Fetch a live sitemap and return its `<loc>` URLs. */
export async function fetchSitemapLocs(sitemapUrl, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sitemapUrl);
  if (!res.ok) throw new Error(`sitemap fetch ${sitemapUrl} → HTTP ${res.status}`);
  return parseSitemapLocs(await res.text());
}

/** Inspect one URL; returns its coverageState (or undefined) plus lastCrawlTime. */
export async function inspectUrl(
  token,
  inspectionUrl,
  { fetchImpl = fetch, siteUrl = SITE_URL } = {},
) {
  const res = await fetchImpl(INSPECT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  });
  const json = await res.json();
  if (json.error)
    throw new Error(`URL inspection failed for ${inspectionUrl}: ${JSON.stringify(json.error)}`);
  const idx = json.inspectionResult?.indexStatusResult ?? {};
  return { url: inspectionUrl, coverageState: idx.coverageState, lastCrawlTime: idx.lastCrawlTime };
}

async function main() {
  const sa = loadServiceAccount();
  const token = await getAccessToken(sa);

  console.log(`# GSC indexation coverage — ${SITE_URL}\n`);

  // 1. Sitemap submission/fetch status.
  const sitemaps = summarizeSitemaps(await fetchSitemapsList(token));
  console.log("## Submitted sitemaps");
  for (const s of sitemaps) {
    console.log(
      `  ${s.path}\n    submitted=${s.lastSubmitted ?? "?"} downloaded=${s.lastDownloaded ?? "NEVER"}` +
        ` pending=${s.pending} submittedUrls=${s.submittedUrls} indexedUrls=${s.indexedUrls}`,
    );
  }

  // 2. Enumerate live URLs.
  const urls = [];
  for (const sm of SITEMAP_URLS) {
    try {
      urls.push(...(await fetchSitemapLocs(sm)));
    } catch (e) {
      console.log(`  ! could not read ${sm}: ${e.message}`);
    }
  }
  const unique = [...new Set(urls)];
  console.log(`\n## Coverage over ${unique.length} live sitemap URLs`);

  // 3. Inspect each URL (serially — the URL Inspection API is per-URL and rate-limited).
  const results = [];
  for (const u of unique) {
    try {
      results.push(await inspectUrl(token, u));
    } catch (e) {
      console.log(`  ! inspect ${u}: ${e.message}`);
      results.push({ url: u, coverageState: undefined });
    }
  }

  const counts = bucketCounts(results.map((r) => classifyCoverage(r.coverageState)));
  for (const b of BUCKETS) console.log(`  ${b.padEnd(24)} ${counts[b]}`);

  // The URLs Google has crawled-but-declined or never seen — the actionable tails.
  const notIndexed = results.filter(
    (r) => !["indexed", "redirect"].includes(classifyCoverage(r.coverageState)),
  );
  if (notIndexed.length) {
    console.log(`\n## Not indexed (${notIndexed.length}) — bucket ← url`);
    for (const r of notIndexed) {
      console.log(`  ${classifyCoverage(r.coverageState).padEnd(24)} ${r.url}`);
    }
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
