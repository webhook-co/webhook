// Server-side, cookieless page analytics for the marketing site. A tiny Worker (../worker/index.ts)
// runs ahead of the static assets, serves the asset unchanged, and — for a successful HTML page view
// only — writes ONE aggregate data point to Cloudflare Workers Analytics Engine. This module is the
// pure, testable core: it decides what we record and, just as importantly, what we never record.
//
// Privacy posture: the analytics DATA POINT stores NO IP, NO device/user identifier, NO full referrer
// (host only), and NO query string beyond the five standard UTM attribution keys, and sets no analytics
// cookie. Country is coarse (country-level, from Cloudflare's edge). It is aggregate measurement, disclosed
// under GDPR Art. 13 on /privacy. Mirrors apps/telemetry's collector: known fields only, bounded lengths,
// bots dropped.
//
// The same handler ALSO sets the first-party first-touch acquisition cookie (activation follow-up) — see
// withFirstTouchCookie / first-touch-capture.ts. That IS a cookie (utm only, no PII), first-touch-wins,
// disclosed on /privacy. Because it is non-essential, it is CONSENT-GATED: the worker sets it only once the
// visitor has accepted via the cookie banner (consent.ts / consent-banner.tsx), never before.

import { withFirstTouchCookie } from "./first-touch-capture";

/** A Workers Analytics Engine data point: up to 20 blobs (strings), doubles (numbers), one index. */
export interface AnalyticsEvent {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

/** The request signals the collector reads. Pure inputs so the whole policy is unit-testable. */
export interface RequestSignals {
  /** The full request URL (only the path + whitelisted UTM keys are ever recorded). */
  url: string;
  /** The Referer header, if any (only its host is recorded). */
  referrer: string | null;
  /** Cloudflare's edge country code (cf-ipcountry), if any. */
  country: string | null;
  /** The User-Agent (used only to drop bots; never stored). */
  userAgent: string | null;
  /** The Content-Type of the asset response (we log HTML page views only). */
  contentType: string | null;
  /** The asset response status (we log 2xx only — not 404s or redirects). */
  status: number;
}

const INDEX_MAX_BYTES = 96; // Analytics Engine allows exactly one index, <= 96 bytes.
const FIELD_MAX = 128;

// Match control characters in untrusted strings — keeps a future dashboard clean, no injection sink today.
// eslint-disable-next-line no-control-regex -- intentionally matching control chars in untrusted input
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Best-effort bot/crawler/monitor filter. Not exhaustive by design (an aggregate marketing metric, not
// an audit log) — it removes the obvious automated traffic that would otherwise dwarf human page views.
const BOT_UA =
  /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|quora|pinterest|slackbot|vkshare|redditbot|applebot|whatsapp|telegrambot|discordbot|headless|puppeteer|playwright|lighthouse|phantomjs|curl|wget|python-requests|axios|go-http-client|node-fetch|okhttp|libwww|monitor|pingdom|uptimerobot|gtmetrix|dataprovider|scrapy/i;

/** A bounded, non-empty, control-char-free string, else "" (over-length is dropped, not truncated). */
function clean(x: string | null | undefined, max = FIELD_MAX): string {
  if (typeof x !== "string" || x.length === 0 || x.length > max || CONTROL_CHARS.test(x)) return "";
  return x;
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a character boundary (the AE index limit is bytes). */
function truncateBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = enc.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/** The referrer's host only — never its path or query (those can carry PII). */
function referrerHost(referrer: string | null): string {
  if (!referrer) return "";
  try {
    return clean(new URL(referrer).host);
  } catch {
    return "";
  }
}

/** A normalised short country code (uppercase A–Z/0–9, e.g. "PT"), else "". */
function normaliseCountry(country: string | null): string {
  if (!country) return "";
  const c = country.toUpperCase();
  return /^[A-Z0-9]{1,8}$/.test(c) ? c : "";
}

function isBot(userAgent: string | null): boolean {
  return !userAgent || userAgent.length === 0 || BOT_UA.test(userAgent);
}

/**
 * Decide whether a request is a loggable HTML page view and, if so, build its aggregate data point.
 * Returns null for anything we must not record: non-HTML assets, non-2xx responses, and bots.
 */
export function buildDataPoint(s: RequestSignals): AnalyticsEvent | null {
  if (s.status < 200 || s.status >= 300) return null; // only successful page views
  if (!s.contentType || !s.contentType.toLowerCase().includes("text/html")) return null;
  if (isBot(s.userAgent)) return null;

  let path: string;
  let query: URLSearchParams;
  try {
    const u = new URL(s.url);
    path = u.pathname;
    query = u.searchParams;
  } catch {
    return null;
  }

  const index = truncateBytes(path, INDEX_MAX_BYTES);
  return {
    blobs: [
      index, // 0: path
      referrerHost(s.referrer), // 1: referrer host
      normaliseCountry(s.country), // 2: country
      clean(query.get("utm_source")), // 3
      clean(query.get("utm_medium")), // 4
      clean(query.get("utm_campaign")), // 5
      clean(query.get("utm_content")), // 6
      clean(query.get("utm_term")), // 7
    ],
    doubles: [s.status],
    indexes: [index], // group-by path (Analytics Engine allows one index, <= 96 bytes)
  };
}

/** The two IO effects the worker shell injects: fetch the static asset, and write a data point. */
export interface AnalyticsBindings {
  fetchAsset: (request: Request) => Promise<Response>;
  writeDataPoint: (event: AnalyticsEvent) => void;
}

/**
 * The worker request handler. Always serves the asset (page serving must never depend on analytics),
 * then records a data point for a successful HTML page view. Reads country from Cloudflare's
 * cf-ipcountry edge header. writeDataPoint failures are swallowed — measurement is best-effort.
 */
export async function handleAnalyticsRequest(
  request: Request,
  deps: AnalyticsBindings,
): Promise<Response> {
  const res = await deps.fetchAsset(request);
  // The whole measurement path is wrapped: serving the page must never depend on analytics, so even
  // an unexpected throw in buildDataPoint or writeDataPoint is swallowed and the asset still returns.
  try {
    const dp = buildDataPoint({
      url: request.url,
      referrer: request.headers.get("referer"),
      country: request.headers.get("cf-ipcountry"),
      userAgent: request.headers.get("user-agent"),
      contentType: res.headers.get("content-type"),
      status: res.status,
    });
    if (dp) deps.writeDataPoint(dp);
  } catch {
    /* analytics must never break serving the page */
  }
  // First-touch acquisition capture: on an HTML view carrying utm, set the first-party `.webhook.co`
  // first-touch cookie the auth signup hook reads (first-touch-wins). Best-effort + total — returns the
  // asset response untouched on any issue, so serving the page never depends on it.
  return withFirstTouchCookie(request, res);
}
