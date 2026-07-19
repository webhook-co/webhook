import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractJsonLdBlocks,
  collectNodes,
  findOrganization,
  checkLiveGraph,
} from "./docs-live-structured-data-check.mjs";

/**
 * The post-deploy proof: Mintlify renders JSON-LD from source we don't build locally, so a green
 * source guard is necessary-not-sufficient. This checks the ACTUAL emitted HTML — that the docs
 * Organization node consolidated onto www's @id and every publisher edge re-pointed to it. Fixtures
 * are the real blocks captured live from docs.webhook.co (before) and their consolidated form (after).
 */

const EXPECTED_ID = "https://www.webhook.co/#organization";
const EXPECTED_URL = "https://www.webhook.co";
const OLD_ID = "https://docs.webhook.co/#organization";

// Mintlify emits TWO ld+json blocks: a standalone WebSite w/ creator:Mintlify (no @id), and the @graph.
const mintlifyCreatorBlock = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "webhook.co",
  creator: { "@type": "Organization", name: "Mintlify", url: "https://mintlify.com" },
})}</script>`;

const graphBlock = (orgId, orgUrl, pubId) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: "webhook.co",
        url: orgUrl,
        // Mintlify emits logo as an ImageObject and re-hosts it — must NOT be required to equal logo.png.
        logo: { "@type": "ImageObject", url: "https://mintcdn.com/webhookco/x/logo/light.svg" },
      },
      {
        "@type": "WebSite",
        "@id": "https://docs.webhook.co#website",
        url: "https://docs.webhook.co",
        publisher: { "@id": pubId },
      },
      {
        "@type": "WebPage",
        "@id": "https://docs.webhook.co/introduction#webpage",
        isPartOf: { "@id": "https://docs.webhook.co#website" },
      },
      {
        "@type": ["Article", "TechArticle"],
        "@id": "https://docs.webhook.co/introduction#article",
        publisher: { "@id": pubId },
        isPartOf: { "@id": "https://docs.webhook.co#website" },
      },
    ],
  })}</script>`;

const brokenHtml = `<html><head>${mintlifyCreatorBlock}${graphBlock(OLD_ID, "https://docs.webhook.co", OLD_ID)}</head></html>`;
const fixedHtml = `<html><head>${mintlifyCreatorBlock}${graphBlock(EXPECTED_ID, EXPECTED_URL, EXPECTED_ID)}</head></html>`;
// The live check only asserts the beacon SRC is present (it doesn't validate the token), so this is a
// short obvious placeholder — not a 32-hex string a secret scanner could mistake for a real key.
const beaconTag = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"cf-beacon-fixture"}'></script>`;

// ── extractJsonLdBlocks / collectNodes / findOrganization ─────────────────────

test("extractJsonLdBlocks finds every ld+json block, not just the first", () => {
  assert.equal(extractJsonLdBlocks(fixedHtml).length, 2);
});

test("collectNodes expands @graph and includes standalone nodes", () => {
  const nodes = collectNodes(extractJsonLdBlocks(fixedHtml));
  assert.ok(nodes.some((n) => n["@type"] === "Organization"));
  assert.ok(nodes.some((n) => Array.isArray(n["@type"]) && n["@type"].includes("TechArticle")));
});

test("findOrganization ignores the creator:Mintlify block (it has no @id) and matches by @id", () => {
  const nodes = collectNodes(extractJsonLdBlocks(fixedHtml));
  const org = findOrganization(nodes, EXPECTED_ID);
  assert.ok(org, "must find the www-@id Organization");
  assert.equal(org.name, "webhook.co");
  assert.equal(findOrganization(nodes, EXPECTED_ID + "-nope"), null);
});

// ── checkLiveGraph: the whole assertion ───────────────────────────────────────

test("checkLiveGraph: the CONSOLIDATED graph passes (Org @id + publisher edges = www)", () => {
  const { errors } = checkLiveGraph(fixedHtml, {
    expectedId: EXPECTED_ID,
    expectedUrl: EXPECTED_URL,
  });
  assert.deepEqual(errors, []);
});

test("checkLiveGraph: a trailing slash on the Organization url does not false-fail", () => {
  const slashed = `<html><head>${graphBlock(EXPECTED_ID, EXPECTED_URL + "/", EXPECTED_ID)}</head></html>`;
  const { errors } = checkLiveGraph(slashed, {
    expectedId: EXPECTED_ID,
    expectedUrl: EXPECTED_URL,
  });
  assert.deepEqual(errors, []);
});

test("checkLiveGraph: the CURRENT broken graph FAILS (org @id + publishers still docs-host)", () => {
  const { errors } = checkLiveGraph(brokenHtml, {
    expectedId: EXPECTED_ID,
    expectedUrl: EXPECTED_URL,
  });
  assert.ok(errors.length > 0, "must fail when the entity is not consolidated");
  assert.ok(
    errors.some((e) => e.includes("Organization")),
    "must flag the missing consolidated Organization",
  );
});

test("checkLiveGraph: an ImageObject logo does not cause a failure", () => {
  // fixedHtml's Organization has an ImageObject logo pointing at mintcdn — that's expected, not an error.
  const { errors } = checkLiveGraph(fixedHtml, {
    expectedId: EXPECTED_ID,
    expectedUrl: EXPECTED_URL,
  });
  assert.ok(!errors.some((e) => e.toLowerCase().includes("logo")));
});

test("checkLiveGraph: a lingering publisher edge to the OLD docs-host @id fails", () => {
  // Org consolidated, but one publisher edge left pointing at the old entity → not fully consolidated.
  const half = `<html><head>${graphBlock(EXPECTED_ID, EXPECTED_URL, OLD_ID)}</head></html>`;
  const { errors } = checkLiveGraph(half, { expectedId: EXPECTED_ID, expectedUrl: EXPECTED_URL });
  assert.ok(
    errors.some((e) => e.includes("publisher")),
    "a stray docs-host publisher edge must fail",
  );
});

test("checkLiveGraph: expectBeacon requires the CF beacon in the HTML", () => {
  assert.ok(
    checkLiveGraph(fixedHtml, {
      expectedId: EXPECTED_ID,
      expectedUrl: EXPECTED_URL,
      expectBeacon: true,
    }).errors.some((e) => e.includes("beacon")),
    "missing beacon must fail when expected",
  );
  assert.deepEqual(
    checkLiveGraph(fixedHtml + beaconTag, {
      expectedId: EXPECTED_ID,
      expectedUrl: EXPECTED_URL,
      expectBeacon: true,
    }).errors,
    [],
  );
});

test("checkLiveGraph FLOOR: no ld+json at all fails (never vacuous)", () => {
  assert.ok(
    checkLiveGraph("<html><head></head></html>", {
      expectedId: EXPECTED_ID,
      expectedUrl: EXPECTED_URL,
    }).errors.length > 0,
  );
});
