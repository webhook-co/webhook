import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPage, extractSitemapLocs, HOST, pageFileForUrl } from "./check-seo-html.mjs";

// The pure helpers are tested against fixtures so the route-aware SEO gate has coverage without a
// full `next build`. The script wiring (walking the emitted sitemap) is exercised in the real
// seo-html-check CI job against out/.

// A minimal <head> that passes every ERROR-level rule for a given URL. Warnings (title length etc.)
// are allowed — we assert on errors, which are what block the build.
function goodHead({ url, ogType = "website", ld = null } = {}) {
  const ldTag = ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : "";
  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"/>
    <title>webhook.co — the inbound webhook gateway for developers</title>
    <meta name="description" content="Capture the webhooks other people send you, verified and never silently dropped, across 142 providers built in."/>
    <link rel="canonical" href="${url}"/>
    <meta property="og:title" content="webhook.co"/>
    <meta property="og:type" content="${ogType}"/>
    <meta property="og:url" content="${url}"/>
    <meta property="og:image" content="${HOST}/og.png"/>
    <meta property="og:image:width" content="1200"/>
    <meta property="og:image:height" content="630"/>
    <meta name="twitter:card" content="summary_large_image"/>
    <meta name="twitter:image" content="${HOST}/og.png"/>
    <meta name="viewport" content="width=device-width"/>
    ${ldTag}
  </head><body></body></html>`;
}

const ORG_LD = {
  "@graph": [
    { "@type": "Organization", name: "webhook.co" },
    { "@type": "WebSite", url: HOST },
  ],
};

test("extractSitemapLocs pulls every <loc> in order", () => {
  const xml = `<urlset><url><loc>${HOST}</loc></url><url><loc>${HOST}/pricing</loc></url></urlset>`;
  assert.deepEqual(extractSitemapLocs(xml), [HOST, `${HOST}/pricing`]);
});

test("pageFileForUrl maps a URL to its FLAT static-export file", () => {
  // Next `output: "export"` (no trailingSlash) emits flat files: dpa.html, not dpa/index.html.
  assert.equal(pageFileForUrl(`${HOST}`), "index.html");
  assert.equal(pageFileForUrl(`${HOST}/`), "index.html");
  assert.equal(pageFileForUrl(`${HOST}/pricing`), "pricing.html");
  assert.equal(pageFileForUrl(`${HOST}/product/verification`), "product/verification.html");
});

test("pageFileForUrl ignores a stray second argument (the .map arity trap)", () => {
  // `locs.map(pageFileForUrl)` would pass the array index as `host`; a numeric host must not defeat
  // the host-strip. Simulate the index arg and require the same result.
  assert.equal(pageFileForUrl(`${HOST}/pricing`, 1), "pricing.html");
});

test("a clean inner page produces zero errors", () => {
  const { errors } = checkPage(goodHead({ url: `${HOST}/pricing` }), { url: `${HOST}/pricing` });
  assert.deepEqual(errors, [], `unexpected errors: ${errors.join("; ")}`);
});

test("an article og:type is accepted, not rejected", () => {
  const url = `${HOST}/product/delivery`;
  const { errors } = checkPage(goodHead({ url, ogType: "article" }), { url });
  assert.deepEqual(errors, [], `article should be valid: ${errors.join("; ")}`);
});

test("an invalid og:type is an error", () => {
  const url = `${HOST}/pricing`;
  const { errors } = checkPage(goodHead({ url, ogType: "banana" }), { url });
  assert.ok(errors.some((e) => e.includes("og:type")));
});

test("a canonical that points at the wrong page is caught (the static-export drift bug)", () => {
  // Page is /pricing but it canonicalises to the homepage — the classic bug this gate exists for.
  const html = goodHead({ url: HOST });
  const { errors } = checkPage(html, { url: `${HOST}/pricing` });
  assert.ok(
    errors.some((e) => e.includes("does not match this page's URL")),
    `expected a canonical-mismatch error, got: ${errors.join("; ")}`,
  );
});

test("noindex in a production page is an error", () => {
  const url = `${HOST}/pricing`;
  const html = goodHead({ url }).replace(
    "<title>",
    '<meta name="robots" content="noindex"/><title>',
  );
  const { errors } = checkPage(html, { url });
  assert.ok(errors.some((e) => e.includes("noindex")));
});

test("the home page REQUIRES an Organization graph; a bare page fails", () => {
  const { errors } = checkPage(goodHead({ url: HOST }), { url: HOST, requireOrgLd: true });
  assert.ok(errors.some((e) => e.includes("JSON-LD")));
});

test("the home page passes once the Organization graph is present", () => {
  const { errors } = checkPage(goodHead({ url: HOST, ld: ORG_LD }), {
    url: HOST,
    requireOrgLd: true,
  });
  assert.deepEqual(errors, [], `unexpected errors: ${errors.join("; ")}`);
});

test("an inner page does NOT require JSON-LD, but a malformed blob still fails", () => {
  const url = `${HOST}/terms`;
  const clean = checkPage(goodHead({ url }), { url });
  assert.deepEqual(clean.errors, []);

  const broken = goodHead({ url }).replace(
    "</head>",
    '<script type="application/ld+json">{ not json </script></head>',
  );
  const { errors } = checkPage(broken, { url });
  assert.ok(errors.some((e) => e.includes("JSON-LD")));
});

// A look-alike origin: `https://www.webhook.co.evil.com` has our canonical host as a *prefix*, so a
// `startsWith(HOST)` check waves it through. The host has to be compared as an ORIGIN, not a string.
const LOOKALIKE = "https://www.webhook.co.evil.com";

test("a look-alike host is not mistaken for the canonical origin (canonical check)", () => {
  const html = goodHead({ url: `${LOOKALIKE}/pricing` });
  const { errors } = checkPage(html, { url: `${LOOKALIKE}/pricing` });
  assert.ok(
    errors.some((e) => e.includes("absolute")),
    `expected a non-canonical-origin error, got: ${errors.join("; ")}`,
  );
});

test("pageFileForUrl maps by PATH, so a look-alike host cannot forge a file path", () => {
  // The old prefix-slice turned this into ".evil.com/pricing.html" — a path outside the export.
  assert.equal(pageFileForUrl(`${LOOKALIKE}/pricing`), "pricing.html");
  assert.equal(pageFileForUrl(`${LOOKALIKE}`), "index.html");
});
