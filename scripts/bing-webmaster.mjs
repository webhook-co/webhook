#!/usr/bin/env node
// Bing Webmaster Tools reader (+ an opt-in URL submitter) for webhook.co.
//
// WHY THIS EXISTS, given Google is the engine that matters: Bing is the only search engine whose
// submission path we can automate at all. Google's Indexing API accepts JobPosting/BroadcastEvent
// only, and Search Console's "Request indexing" is UI-only — so every Google submission is a human
// clicking a button. Bing exposes SubmitUrlBatch at a 100/day, 800/month quota. See
// internal/marketing/seo-indexation-diagnosis.md.
//
// It also gives us a SECOND, INDEPENDENT read on the indexation diagnosis. Bing's GetCrawlStats
// reports `InIndex` and `InLinks` directly — where Google only let us infer "no authority" from the
// fact that its sole reported referrers were spam domains, Bing states the inbound-link count as a
// number. Two engines disagreeing would have falsified the diagnosis; they agree.
//
// Auth is a single API key (Bing Webmaster Tools → Settings → API Access → API Key). ⚠️ The key
// travels in the QUERY STRING, so nothing here may print a raw URL — every logged or thrown string
// goes through redact(). Pure helpers are exported and unit-tested WITHOUT network; the fetches take
// an injectable fetchImpl so tests never contact Bing.

import { readFileSync } from "node:fs";

import { isMain } from "./lib/docs-lib.mjs";

export const API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

/** The site as REGISTERED in Bing Webmaster Tools. Bing keys everything off this exact string. */
export const DEFAULT_SITE = "https://webhook.co/";

/** Hosts we may read or submit for: webhook.co itself and any subdomain of it. */
const ALLOWED_APEX = "webhook.co";

/**
 * Strip the API key from anything about to be printed or thrown.
 *
 * The key is a query parameter, so an unredacted URL in an error message is a credential in the
 * operator's scrollback and in this session's transcript. Redaction is applied at the boundary
 * (logging/throwing) rather than trusting each call site to remember.
 */
const SECRETS = new Set();

/**
 * Register a literal secret so redact() scrubs it wherever it appears, not only in an `apikey=`
 * parameter. Defence in depth: an upstream error body that echoes the key back, or any future call
 * site that interpolates it outside a query string, would otherwise print it in full.
 */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) SECRETS.add(value);
}

export function redact(text) {
  let out = String(text).replace(/(apikey=)[^&\s]+/gi, "$1REDACTED");
  for (const s of SECRETS) out = out.split(s).join("REDACTED");
  return out;
}

/** Build a JSON-endpoint URL. Never log the return value directly — pass it through redact(). */
export function bingUrl(method, apiKey, params = {}) {
  const u = new URL(`${API_BASE}/${method}`);
  u.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Refuse any site/URL that is not webhook.co or a subdomain, BEFORE any network call.
 *
 * Compares the PARSED hostname. A `startsWith`/`includes` check would admit
 * `https://webhook.co.evil.com/` — the incomplete-URL-substring-sanitization defect CodeQL flags at
 * HIGH severity, and which it has already flagged once in this repo's test code.
 */
export function assertSiteAllowed(siteUrl) {
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error(`not an allowed site (unparseable): ${siteUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`not an allowed site (must be https): ${siteUrl}`);
  }
  const h = parsed.hostname.toLowerCase();
  if (h !== ALLOWED_APEX && !h.endsWith(`.${ALLOWED_APEX}`)) {
    throw new Error(`not an allowed site (host ${h}): ${siteUrl}`);
  }
  return siteUrl;
}

/**
 * Parse the WCF `/Date(ms)/` wire format to an ISO string, or null when absent/unparseable.
 *
 * Some fields carry a trailing offset (`/Date(1784098800000-0700)/`). The epoch is already UTC, so
 * the offset is presentational — applying it would shift the instant by seven hours.
 */
export function parseDotNetDate(value) {
  if (typeof value !== "string") return null;
  // Deliberately string slicing rather than a regex. The natural pattern here — a greedy run of
  // digits followed by an OPTIONAL fixed-width offset — is what `security/detect-unsafe-regex`
  // warns on, and a linter warning that is permanently "fine, ignore it" is how a real one later
  // gets ignored too. There is no pattern to match: the format is a fixed prefix and suffix.
  if (!value.startsWith("/Date(") || !value.endsWith(")/")) return null;
  let inner = value.slice("/Date(".length, -")/".length);
  // Drop a presentational timezone offset (`-0700`), never apply it — the epoch is already UTC.
  const offsetAt = inner.search(/[+-]\d{4}$/);
  if (offsetAt > 0) inner = inner.slice(0, offsetAt);
  if (!/^-?\d+$/.test(inner)) return null;
  const n = Number(inner);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

/** Verification state per registered site. Deliberately drops the authentication codes. */
export function summarizeSites(rows) {
  return (rows ?? []).map((r) => ({ url: r.Url, verified: Boolean(r.IsVerified) }));
}

/** Submitted sitemaps with fetch status. `lastCrawled: null` means Bing has never fetched it. */
export function summarizeFeeds(rows) {
  return (rows ?? []).map((r) => ({
    url: r.Url,
    status: r.Status ?? "?",
    urlCount: r.UrlCount ?? 0,
    submitted: parseDotNetDate(r.Submitted),
    lastCrawled: parseDotNetDate(r.LastCrawled),
  }));
}

/** The most recent day in a crawl-stats series, chosen by DATE rather than array position. */
export function latestCrawlRow(rows) {
  const parsed = (rows ?? [])
    .map((r) => ({ ...r, iso: parseDotNetDate(r.Date) }))
    .filter((r) => r.iso)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  const last = parsed.at(-1);
  if (!last) return null;
  return {
    date: last.iso.slice(0, 10),
    crawledPages: last.CrawledPages ?? 0,
    inIndex: last.InIndex ?? 0,
    inLinks: last.InLinks ?? 0,
    blockedByRobots: last.BlockedByRobotsTxt ?? 0,
    code4xx: last.Code4xx ?? 0,
    code5xx: last.Code5xx ?? 0,
  };
}

export function parseArgs(argv) {
  const rest = [...argv];
  let siteUrl = DEFAULT_SITE;
  let confirm = false;
  const positional = [];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--site") siteUrl = rest.shift();
    else if (a === "--confirm") confirm = true;
    else positional.push(a);
  }
  const command = positional.shift() ?? "crawl";
  return { command, siteUrl, confirm, urls: positional };
}

function loadApiKey(env = process.env) {
  const key = readKey(env);
  registerSecret(key);
  return key;
}

function readKey(env) {
  if (env.BING_WEBMASTER_API_KEY) return env.BING_WEBMASTER_API_KEY.trim();
  if (env.BING_WEBMASTER_API_KEY_FILE) {
    return readFileSync(env.BING_WEBMASTER_API_KEY_FILE, "utf8").trim();
  }
  throw new Error(
    "no API key: set BING_WEBMASTER_API_KEY or BING_WEBMASTER_API_KEY_FILE (see the bing-webmaster-api-key memory)",
  );
}

/**
 * Request options shared by every call. `redirect: "error"` is load-bearing rather than tidiness:
 * the API key rides in the QUERY STRING, so following a redirect would hand the full URL — key
 * included — to whatever host the redirect names.
 */
const REQUEST_INIT = { redirect: "error", referrerPolicy: "no-referrer" };

async function getJson(method, apiKey, params, fetchImpl = fetch) {
  const url = bingUrl(method, apiKey, params);
  const res = await fetchImpl(url, { ...REQUEST_INIT });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(redact(`${method} failed (HTTP ${res.status}): ${text}`));
  }
  return JSON.parse(text).d;
}

export async function fetchSites(apiKey, { fetchImpl = fetch } = {}) {
  return summarizeSites(await getJson("GetUserSites", apiKey, {}, fetchImpl));
}

export async function fetchFeeds(apiKey, siteUrl, { fetchImpl = fetch } = {}) {
  assertSiteAllowed(siteUrl);
  return summarizeFeeds(await getJson("GetFeeds", apiKey, { siteUrl }, fetchImpl));
}

export async function fetchCrawlStats(apiKey, siteUrl, { fetchImpl = fetch } = {}) {
  assertSiteAllowed(siteUrl);
  return (await getJson("GetCrawlStats", apiKey, { siteUrl }, fetchImpl)) ?? [];
}

export async function fetchQuota(apiKey, siteUrl, { fetchImpl = fetch } = {}) {
  assertSiteAllowed(siteUrl);
  const d = await getJson("GetUrlSubmissionQuota", apiKey, { siteUrl }, fetchImpl);
  return { daily: d?.DailyQuota ?? 0, monthly: d?.MonthlyQuota ?? 0 };
}

/**
 * Submit URLs for crawling. A WRITE against a third party's index — every URL is checked against the
 * allowlist first, and an empty batch is refused rather than POSTed as a no-op.
 */
export async function submitUrlBatch(apiKey, siteUrl, urls, { fetchImpl = fetch } = {}) {
  assertSiteAllowed(siteUrl);
  if (!urls?.length) throw new Error("no URLs to submit");
  for (const u of urls) assertSiteAllowed(u);
  const res = await fetchImpl(bingUrl("SubmitUrlbatch", apiKey, {}), {
    ...REQUEST_INIT,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteUrl, urlList: urls }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`SubmitUrlbatch failed (HTTP ${res.status}): ${text}`));
  return { submitted: urls.length };
}

/**
 * The CLI body, with its dependencies injected so the SAFETY BEHAVIOUR is testable — not just the
 * argument parser. `--confirm` gating the write was previously asserted only on parseArgs, which
 * would have stayed green through a regression that submitted unconditionally.
 */
export async function run(argv, { fetchImpl = fetch, env = process.env, log = console.log } = {}) {
  const apiKey = loadApiKey(env);
  const { command, siteUrl, confirm, urls } = parseArgs(argv);

  if (command === "sites") {
    for (const s of await fetchSites(apiKey, { fetchImpl })) {
      log(`  ${s.verified ? "verified" : "UNVERIFIED"}  ${s.url}`);
    }
    return 0;
  }

  if (command === "feeds") {
    log(`# Submitted sitemaps — ${siteUrl}\n`);
    for (const f of await fetchFeeds(apiKey, siteUrl, { fetchImpl })) {
      log(
        `  ${f.url}\n    status=${f.status} urls=${f.urlCount} submitted=${f.submitted ?? "?"} lastCrawled=${f.lastCrawled ?? "NEVER"}`,
      );
    }
    return 0;
  }

  if (command === "quota") {
    const q = await fetchQuota(apiKey, siteUrl, { fetchImpl });
    log(`  daily=${q.daily} monthly=${q.monthly}`);
    return 0;
  }

  if (command === "submit") {
    const q = await fetchQuota(apiKey, siteUrl, { fetchImpl });
    if (!confirm) {
      log(`# DRY RUN — ${urls.length} URL(s) would be submitted to ${siteUrl}`);
      for (const u of urls) log(`  · ${u}`);
      log(`\n  quota: daily=${q.daily} monthly=${q.monthly}`);
      log("  Re-run with --confirm to actually submit.");
      return 0;
    }
    const out = await submitUrlBatch(apiKey, siteUrl, urls, { fetchImpl });
    log(`  submitted ${out.submitted} URL(s); remaining quota daily=${q.daily}`);
    return 0;
  }

  // Default: the crawl/index report — the second opinion on the indexation diagnosis.
  const rows = await fetchCrawlStats(apiKey, siteUrl, { fetchImpl });
  const latest = latestCrawlRow(rows);
  log(`# Bing crawl + index — ${siteUrl}\n`);
  if (!latest) {
    log("  no crawl stats returned");
    return 0;
  }
  log(
    `  latest ${latest.date}: crawled=${latest.crawledPages} inIndex=${latest.inIndex} inLinks=${latest.inLinks}` +
      ` 4xx=${latest.code4xx} 5xx=${latest.code5xx} robotsBlocked=${latest.blockedByRobots}`,
  );
  const totalCrawled = rows.reduce((n, r) => n + (r.CrawledPages ?? 0), 0);
  log(`  ${rows.length}-day window: ${totalCrawled} pages crawled`);
  if (latest.inLinks === 0) {
    log(
      "\n  ⚠️ inLinks=0 — Bing reports ZERO inbound links. This is the authority constraint stated\n" +
        "     directly rather than inferred; no on-site change moves it. See\n" +
        "     internal/marketing/seo-indexation-diagnosis.md.",
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(redact(e.message));
      process.exit(1);
    });
}
