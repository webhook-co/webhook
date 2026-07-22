import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUCKETS,
  bucketCounts,
  classifyCoverage,
  parseSitemapLocs,
  summarizeSitemaps,
} from "./gsc-index-coverage.mjs";

test("parseSitemapLocs: extracts every <loc> URL, trimming whitespace", () => {
  const xml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://www.webhook.co/</loc><lastmod>2026-07-22</lastmod></url>
      <url><loc>
        https://www.webhook.co/pricing
      </loc></url>
    </urlset>`;
  assert.deepEqual(parseSitemapLocs(xml), [
    "https://www.webhook.co/",
    "https://www.webhook.co/pricing",
  ]);
});

test("parseSitemapLocs: returns [] for a document with no <loc>", () => {
  assert.deepEqual(parseSitemapLocs("<urlset></urlset>"), []);
});

test("classifyCoverage: maps the known GSC coverageState strings to buckets", () => {
  assert.equal(classifyCoverage("Submitted and indexed"), "indexed");
  assert.equal(classifyCoverage("Indexed, not submitted in sitemap"), "indexed");
  assert.equal(classifyCoverage("Crawled - currently not indexed"), "crawled-not-indexed");
  assert.equal(classifyCoverage("Discovered - currently not indexed"), "discovered-not-indexed");
  assert.equal(classifyCoverage("URL is unknown to Google"), "unknown");
  assert.equal(classifyCoverage("Page with redirect"), "redirect");
});

test("classifyCoverage: unrecognised or missing state falls back to 'other'", () => {
  assert.equal(classifyCoverage("Duplicate without user-selected canonical"), "other");
  assert.equal(classifyCoverage(undefined), "other");
  assert.equal(classifyCoverage(""), "other");
});

test("bucketCounts: tallies classified coverage states across the known buckets", () => {
  const states = [
    "Submitted and indexed",
    "Submitted and indexed",
    "Crawled - currently not indexed",
    "URL is unknown to Google",
    "URL is unknown to Google",
    "URL is unknown to Google",
  ];
  const counts = bucketCounts(states.map(classifyCoverage));
  assert.equal(counts.indexed, 2);
  assert.equal(counts["crawled-not-indexed"], 1);
  assert.equal(counts.unknown, 3);
  assert.equal(counts["discovered-not-indexed"], 0);
  // Every declared bucket is present as a key even at zero, so a run is never a silent gap.
  for (const b of BUCKETS) assert.ok(b in counts, `bucket ${b} missing`);
});

test("summarizeSitemaps: flattens the Sitemaps API response, flagging never-downloaded ones", () => {
  const apiResponse = {
    sitemap: [
      {
        path: "https://docs.webhook.co/sitemap.xml",
        lastSubmitted: "2026-07-13T11:10:55.770Z",
        isPending: true,
        warnings: "0",
        errors: "0",
      },
      {
        path: "https://www.webhook.co/sitemap.xml",
        lastSubmitted: "2026-07-12T19:20:59.160Z",
        isPending: false,
        lastDownloaded: "2026-07-19T17:24:33.887Z",
        contents: [{ type: "web", submitted: "13", indexed: "0" }],
      },
    ],
  };
  const rows = summarizeSitemaps(apiResponse);
  assert.equal(rows.length, 2);

  const docs = rows.find((r) => r.path.includes("docs."));
  assert.equal(docs.everDownloaded, false);
  assert.equal(docs.pending, true);
  assert.equal(docs.submittedUrls, 0);

  const www = rows.find((r) => r.path.includes("www."));
  assert.equal(www.everDownloaded, true);
  assert.equal(www.pending, false);
  assert.equal(www.submittedUrls, 13);
  assert.equal(www.indexedUrls, 0);
});

test("summarizeSitemaps: tolerates an empty response", () => {
  assert.deepEqual(summarizeSitemaps({}), []);
  assert.deepEqual(summarizeSitemaps({ sitemap: [] }), []);
});
