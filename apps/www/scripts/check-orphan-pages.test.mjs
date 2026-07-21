import assert from "node:assert/strict";
import { test } from "node:test";

import { findOrphans, inboundCounts, internalLinks, normalizePath } from "./check-orphan-pages.mjs";

// This guard exists because sixteen pages shipped unreachable with a fully green CI. The route
// manifest already gated sitemap membership, SEO heads, a11y and export — four checks, none of which
// can answer the question that decides whether a page has an audience: can you get there from here?

test("normalizePath gives one destination one identity", () => {
  assert.equal(normalizePath("/test/"), "/test");
  assert.equal(normalizePath("/test?utm_source=x"), "/test");
  assert.equal(normalizePath("/verify#how"), "/verify");
  assert.equal(normalizePath("/"), "/");
});

test("internalLinks collects site-absolute hrefs and ignores off-site ones", () => {
  const html = [
    '<a href="/verify">v</a>',
    '<a href="/test">t</a>',
    '<a href="https://docs.webhook.co">docs</a>',
    '<a href="mailto:hello@webhook.co">mail</a>',
    '<a href="#main">skip</a>',
  ].join("\n");
  assert.deepEqual(internalLinks(html), ["/verify", "/test"]);
});

// `[^>]+` is a negated class, not `.`, so it spans the newlines prettier puts between attributes.
// Getting this wrong is how a formatter-wrapped tag drops out of the link graph — and a MISSING link
// here reads as "that page is an orphan", which would make the guard cry wolf until someone disables it.
test("internalLinks is not fooled by attribute order or newlines", () => {
  assert.deepEqual(internalLinks('<a\n  class="x"\n  href="/play"\n  data-y="1">play</a>'), [
    "/play",
  ]);
  assert.deepEqual(internalLinks('<a\tclass="x" href="/test">t</a>'), ["/test"]);
});

test("inboundCounts ignores self-links — a breadcrumb is not a way in", () => {
  const counts = inboundCounts([
    { path: "/", html: '<a href="/verify">v</a>' },
    { path: "/verify", html: '<a href="/verify">self</a>' },
  ]);
  assert.equal(counts.get("/verify"), 1);
});

test("inboundCounts counts each linking page once, however often it repeats the link", () => {
  const counts = inboundCounts([
    { path: "/", html: '<a href="/test">a</a><a href="/test">b</a>' },
    { path: "/pricing", html: '<a href="/test">c</a>' },
  ]);
  assert.equal(counts.get("/test"), 2);
});

test("findOrphans names a sitemapped page nothing links to", () => {
  const counts = inboundCounts([{ path: "/", html: '<a href="/verify">v</a>' }]);
  assert.deepEqual(findOrphans(["/", "/verify", "/test/stripe"], counts), ["/test/stripe"]);
});

test("findOrphans exempts the homepage, reachable by definition", () => {
  assert.deepEqual(findOrphans(["/"], new Map()), []);
});

test("findOrphans passes when every page has an inbound link", () => {
  const counts = inboundCounts([
    { path: "/", html: '<a href="/test">t</a>' },
    { path: "/test", html: '<a href="/test/stripe">s</a>' },
  ]);
  assert.deepEqual(findOrphans(["/", "/test", "/test/stripe"], counts), []);
});

// The floor. "No routes to check" and "no orphans found" are the same value otherwise — and reporting
// success for work never done is exactly the failure this guard was written to catch, one level up.
test("findOrphans refuses to pass vacuously on an empty route list", () => {
  assert.throws(() => findOrphans([], new Map()), /no routes/i);
});
