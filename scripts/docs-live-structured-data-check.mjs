#!/usr/bin/env node
// POST-DEPLOY live proof for the docs entity consolidation (apps/docs). NON-BLOCKING.
//
// Mintlify builds + deploys apps/docs externally (GitHub App on push to main), and the free plan has
// no PR preview — so a PR-time check gates the merge but never the real deploy, and docs.json source
// presence (docs-structured-data-guard.mjs) does NOT prove Mintlify RENDERED the consolidation. This
// fetches the LIVE HTML and asserts the emitted JSON-LD actually consolidated the docs Organization
// onto www's @id, with every publisher edge re-pointed. This is the completion gate for the lane
// (verify the live artifact — a diagnosis that implies "just wait for it to propagate" is a smell).
//
// It cannot gate a PR (deploy is post-merge). Run it by hand after a docs deploy, or wire it as a
// scheduled/manual CI alarm. Pure parsing/assertion is exported + unit-tested against real fixtures;
// only the fetch lives in the entrypoint.

import { isMain } from "./lib/docs-lib.mjs";

const EXPECTED_ID = "https://www.webhook.co/#organization";
const EXPECTED_URL = "https://www.webhook.co";
const OLD_DOCS_ORG_ID = "https://docs.webhook.co/#organization";
const DEFAULT_PAGES = [
  "https://docs.webhook.co/introduction",
  "https://docs.webhook.co/quickstart",
];

/** Every `<script type="application/ld+json">…</script>` payload, parsed. Skips blocks that don't parse. */
export function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html ?? "")) !== null) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      // a malformed block is not our concern here; the fixtures/live pages emit valid JSON.
    }
  }
  return blocks;
}

/** Flatten every node across all blocks, expanding any `@graph` arrays. */
export function collectNodes(blocks) {
  const nodes = [];
  for (const block of blocks) {
    if (Array.isArray(block?.["@graph"])) nodes.push(...block["@graph"]);
    else if (block && typeof block === "object") nodes.push(block);
  }
  return nodes;
}

const typesOf = (n) => (Array.isArray(n?.["@type"]) ? n["@type"] : [n?.["@type"]]);

/** The Organization node whose @id === id (the creator:Mintlify block has no @id, so it's ignored). */
export function findOrganization(nodes, id) {
  return nodes.find((n) => typesOf(n).includes("Organization") && n?.["@id"] === id) ?? null;
}

/** Every `publisher.@id` referenced anywhere in the graph. */
function publisherIds(nodes) {
  return nodes.map((n) => n?.publisher?.["@id"]).filter((v) => typeof v === "string");
}

const stripTrailingSlash = (u) => (typeof u === "string" ? u.replace(/\/+$/, "") : u);

/**
 * Assert the live graph consolidated onto `expectedId`. Returns { errors, warnings }. Notes:
 * - logo is intentionally NOT checked (Mintlify emits it as an ImageObject and re-hosts it).
 * - sameAs is best-effort (Mintlify may strip it) — a missing sameAs is a warning, never an error.
 * - the docs WebSite keeps its own @id (correct — docs is a distinct site); only publisher edges and
 *   the Organization @id must point at the shared www Organization.
 */
export function checkLiveGraph(html, { expectedId, expectedUrl, expectBeacon = false } = {}) {
  const errors = [];
  const warnings = [];

  const blocks = extractJsonLdBlocks(html);
  if (blocks.length === 0) {
    errors.push(
      "no <script type=application/ld+json> blocks found — page not rendered, or not Mintlify.",
    );
    return { errors, warnings };
  }
  const nodes = collectNodes(blocks);

  const org = findOrganization(nodes, expectedId);
  if (!org) {
    errors.push(
      `no Organization node with @id="${expectedId}" — the docs entity did NOT consolidate onto www ` +
        `(is it still ${OLD_DOCS_ORG_ID}?).`,
    );
  } else {
    // Slash-tolerant: Mintlify emits url verbatim today, but seo.trailingSlash could normalize it —
    // a trailing slash must not false-fail the completion gate.
    if (expectedUrl && stripTrailingSlash(org.url) !== stripTrailingSlash(expectedUrl))
      errors.push(`Organization.url is "${org.url}" — expected "${expectedUrl}".`);
    if (!Array.isArray(org.sameAs) || org.sameAs.length === 0)
      warnings.push("Organization has no sameAs in the rendered output (Mintlify may strip it).");
  }

  // Every publisher edge must reference the consolidated Organization; a lingering docs-host publisher
  // means the fix only half-applied.
  const pubs = publisherIds(nodes);
  if (pubs.length === 0) warnings.push("no publisher edges found in the graph.");
  for (const pid of pubs) {
    if (pid !== expectedId)
      errors.push(`a publisher edge references "${pid}" — expected "${expectedId}".`);
  }

  if (expectBeacon && !html.includes("static.cloudflareinsights.com/beacon.min.js"))
    errors.push(
      "Cloudflare Web Analytics beacon (static.cloudflareinsights.com/beacon.min.js) not found.",
    );

  return { errors, warnings };
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": "webhook-co-docs-live-check/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const expectBeacon = args.includes("--expect-beacon");
  const pages = args.filter((a) => a.startsWith("http"));
  const urls = pages.length ? pages : DEFAULT_PAGES;

  let failed = false;
  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      const { errors, warnings } = checkLiveGraph(html, {
        expectedId: EXPECTED_ID,
        expectedUrl: EXPECTED_URL,
        expectBeacon,
      });
      for (const w of warnings) console.warn(`⚠ ${url}: ${w}`);
      if (errors.length) {
        failed = true;
        console.error(`✗ ${url}:`);
        for (const e of errors) console.error(`    ${e}`);
      } else {
        console.log(
          `✔ ${url}: Organization consolidated onto ${EXPECTED_ID}${expectBeacon ? " + beacon live" : ""}.`,
        );
      }
    } catch (err) {
      failed = true;
      console.error(`✗ ${url}: ${err.message}`);
    }
  }
  if (failed) {
    console.error(
      "\nLive docs structured-data check FAILED. If a deploy just landed, Mintlify may still be " +
        "building — re-run in a minute; a persistent failure means seo.organization didn't take.",
    );
    process.exit(1);
  }
  console.log("\n✔ Live docs entity consolidation verified.");
}
