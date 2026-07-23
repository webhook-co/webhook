#!/usr/bin/env node
// IndexNow bulk submission — pushes our published URLs to the IndexNow network.
//
// WHAT THIS REACHES: Bing, Yandex, Seznam, Naver and Yep. **Not Google** — Google ran a test in 2021
// and never shipped support, so nothing here moves Google rankings or Google indexation. The reason to
// run it is Bing (and the smaller engines), where we are close to absent.
//
// PROTOCOL (indexnow.org):
//   - The key is 8-128 chars from [a-zA-Z0-9-] and is PUBLIC BY DESIGN: it is published as a text file
//     at the root of each host. It is not a credential and carries no privilege beyond "may submit URLs
//     for this host" — which is why it is committed rather than kept in a secret store.
//   - Each HOST is a separate property, with its own key file at its own root. A key on the apex does
//     NOT cover subdomains. Only www.webhook.co participates — see SITEMAP_FOR_HOST for why docs cannot.
//   - `host` must match every URL in `urlList`; a mismatch is answered with 422.
//   - Up to 10,000 URLs per request.
//
// Usage (host is required; URLs are read from that host's sitemap):
//   pnpm indexnow www.webhook.co
//   pnpm indexnow www.webhook.co --dry-run     # print the payload, submit nothing

import { isMain } from "./lib/docs-lib.mjs";

/** The IndexNow endpoint. Submitting to one participant shares the notification with all of them. */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Our IndexNow key. Public by design — served at `https://<host>/<key>.txt` on every host we submit
 * for. Changing it means re-deploying every key file first, or submissions start failing verification.
 */
// generic-api-key fires on the name "KEY" plus entropy alone. This value is PUBLISHED at
// https://<host>/<key>.txt on every host we submit for; a scanner finding it in the repo has found
// nothing that is not already served to the open internet.
//
// ⚠️ The directive MUST sit on the SAME LINE as the finding. A `// gitleaks:allow` comment on the
// lines ABOVE does nothing — that is how this shipped broken in #782 and turned main red.
export const INDEXNOW_KEY = "b6e87fae-5113-40e1-91ad-694f702bf028"; // gitleaks:allow

/** Protocol ceiling for a single POST. */
export const MAX_URLS_PER_REQUEST = 10_000;

/** The registrable domain we may submit for. */
const ALLOWED_APEX = "webhook.co";

/**
 * Where each submittable host's sitemap lives, so a run enumerates what we actually publish.
 *
 * `docs.webhook.co` is deliberately ABSENT and should not be re-added. It cannot participate:
 * IndexNow requires a key file at the host's root, docs is served by Mintlify, and Mintlify serves
 * `.txt` on Enterprise plans only. Measured 2026-07-23 — the key file was deployed to `apps/docs/` and
 * `https://docs.webhook.co/<key>.txt` returned `404 Asset not found`, so the file was removed rather
 * than left as dead weight. Bing coverage for the docs host comes from Bing Webmaster Tools' Search
 * Console import instead, which needs no key file.
 */
export const SITEMAP_FOR_HOST = new Map([["www.webhook.co", "https://www.webhook.co/sitemap.xml"]]);

/** The public URL of the key file for `host` (pure). Root of the host, per the protocol. */
export function keyLocationFor(host) {
  return `https://${host}/${INDEXNOW_KEY}.txt`;
}

/**
 * Return `host` if we are allowed to submit for it; throw otherwise (pure).
 *
 * Compares the hostname exactly, requiring a dot boundary for subdomains, so `evilwebhook.co` and
 * `webhook.co.evil.com` are both refused.
 */
export function assertHostAllowed(host) {
  const h = String(host ?? "").toLowerCase();
  if (h !== ALLOWED_APEX && !h.endsWith(`.${ALLOWED_APEX}`)) {
    throw new Error(`Refusing host "${host}": not ${ALLOWED_APEX} or a subdomain of it.`);
  }
  return host;
}

/**
 * Return `urls` if every one is on `host`; otherwise throw naming the offenders (pure).
 * IndexNow answers a mismatch with a bare 422, so catching it locally is far more legible.
 */
export function assertUrlsMatchHost(host, urls) {
  const bad = urls.filter((u) => {
    try {
      return new URL(u).hostname.toLowerCase() !== String(host).toLowerCase();
    } catch {
      return true;
    }
  });
  if (bad.length > 0) {
    throw new Error(
      `${bad.length} URL(s) are not on host "${host}" (IndexNow would answer 422): ` +
        `${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", …" : ""}`,
    );
  }
  return urls;
}

/** The IndexNow request body (pure). */
export function buildPayload(host, urls) {
  return {
    host,
    key: INDEXNOW_KEY,
    keyLocation: keyLocationFor(host),
    urlList: urls,
  };
}

/** Split `items` into runs of at most `size` (pure). */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Extract `<loc>` URLs from a sitemap document (pure). */
export function parseSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)]
    .map((m) =>
      m[1]
        .replace(/^\s*<!\[CDATA\[/, "")
        .replace(/\]\]>\s*$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Confirm the key file is actually deployed and serves the key, or throw.
 *
 * Submitting against a key the engines cannot verify wastes the submission, so this runs before any
 * POST. The body is compared after trimming: a static host may append a trailing newline. An `ok`
 * response whose body is not the key (a soft-404 HTML page, say) is treated as failure — otherwise a
 * host that 200s everything would look verified.
 */
export async function verifyKeyLive(host, { fetchImpl = fetch } = {}) {
  // Guarded here too, not just in submitBatch: this function is exported and issues an outbound GET
  // to `https://<host>/…`, so an unchecked host would make it a request primitive pointed anywhere.
  assertHostAllowed(host);
  const location = keyLocationFor(host);
  const res = await fetchImpl(location);
  if (!res.ok) {
    throw new Error(`Key file is not live at ${location}: HTTP ${res.status}.`);
  }
  const body = (await res.text()).trim();
  if (body !== INDEXNOW_KEY) {
    throw new Error(
      `Key file at ${location} does not contain the key (served ${body.length} chars). ` +
        `The host may not serve .txt files.`,
    );
  }
  return true;
}

/** Verify the key, then submit one batch of URLs for `host`. */
export async function submitBatch(host, urls, { fetchImpl = fetch } = {}) {
  assertHostAllowed(host); // before the network, deliberately
  assertUrlsMatchHost(host, urls);
  await verifyKeyLive(host, { fetchImpl });

  const res = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(buildPayload(host, urls)),
  });
  if (!res.ok) {
    throw new Error(
      `IndexNow rejected the submission for ${host}: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return { host, count: urls.length, status: res.status };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const host = args.find((a) => !a.startsWith("--"));
  if (!host) {
    throw new Error(
      `Usage: pnpm indexnow <host> [--dry-run]   (hosts: ${[...SITEMAP_FOR_HOST.keys()].join(", ")})`,
    );
  }
  assertHostAllowed(host);

  const sitemap = SITEMAP_FOR_HOST.get(host);
  if (!sitemap) throw new Error(`No sitemap configured for "${host}".`);

  const res = await fetch(sitemap);
  if (!res.ok) throw new Error(`sitemap fetch ${sitemap} -> HTTP ${res.status}`);
  const urls = [...new Set(parseSitemapLocs(await res.text()))];
  assertUrlsMatchHost(host, urls);

  console.log(`# IndexNow — ${host}`);
  console.log(`  sitemap:     ${sitemap}`);
  console.log(`  urls:        ${urls.length}`);
  console.log(`  keyLocation: ${keyLocationFor(host)}`);
  console.log(`  endpoint:    ${INDEXNOW_ENDPOINT}`);
  console.log(`  reaches:     Bing, Yandex, Seznam, Naver, Yep (NOT Google)\n`);

  if (dryRun) {
    console.log("  --dry-run: nothing submitted.");
    return 0;
  }

  for (const batch of chunk(urls, MAX_URLS_PER_REQUEST)) {
    const out = await submitBatch(host, batch);
    console.log(`  submitted ${out.count} URLs -> HTTP ${out.status}`);
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
