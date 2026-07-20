// The first-touch acquisition cookie — the single source of the wire format + attributes shared by www, web,
// and auth (activation follow-up). A first-party `.webhook.co` cookie set on the first utm-carrying visit and
// read by the auth signup hook; on the shared parent apex it rides to auth.webhook.co automatically (no URL
// propagation), and works for OAuth too. Pure + client-safe (no node/browser deps). TOTAL: a hostile or
// truncated value degrades to "no attribution", never throws — it must never break a page load or a signup.
//
// The stored value is raw-ish utm (only length-bounded here for cookie-size safety); the AUTHORITATIVE
// normalization (allowlist + 64-char drop) happens once at the read side via `normalizeFirstTouch` (db).

/** Cookie name. */
export const FIRST_TOUCH_COOKIE = "wh_first_touch";

/** 90 days — long enough to attribute a signup that follows a first visit by weeks, bounded so it expires. */
export const FIRST_TOUCH_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** Hard cap on a stored dimension (cookie-size safety; the read side re-normalizes to the real 64 limit). */
const MAX_LEN = 128;

/** Raw utm triple as read from a URL or a cookie — each dimension optional, unnormalized. Structurally the
 *  shape `normalizeFirstTouch` (db) accepts. */
export interface RawFirstTouch {
  source?: string;
  medium?: string;
  campaign?: string;
}

/** Extract the three utm dimensions from a URL query string. Drops an over-long value (cookie-size safety)
 *  rather than storing it; only present keys appear in the result. Never throws. */
export function firstTouchFromQuery(search: string): RawFirstTouch {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pick = (key: string): string | undefined => {
    const v = params.get(key);
    return v != null && v !== "" && v.length <= MAX_LEN ? v : undefined;
  };
  const out: RawFirstTouch = {};
  const source = pick("utm_source");
  const medium = pick("utm_medium");
  const campaign = pick("utm_campaign");
  if (source !== undefined) out.source = source;
  if (medium !== undefined) out.medium = medium;
  if (campaign !== undefined) out.campaign = campaign;
  return out;
}

/** Encode a raw touch to a compact cookie value (`s=…&m=…&c=…`, url-encoded, only present dimensions). An
 *  empty touch encodes to `""` — the signal that there is nothing to set. */
export function encodeFirstTouch(raw: RawFirstTouch): string {
  const params = new URLSearchParams();
  if (raw.source) params.set("s", raw.source);
  if (raw.medium) params.set("m", raw.medium);
  if (raw.campaign) params.set("c", raw.campaign);
  return params.toString();
}

/** Decode a cookie value back to a raw touch. TOTAL — garbage, empty, or partial input yields only the clean
 *  keys it can recover, never a throw. */
export function decodeFirstTouch(value: string): RawFirstTouch {
  const out: RawFirstTouch = {};
  try {
    const params = new URLSearchParams(value);
    const source = params.get("s");
    const medium = params.get("m");
    const campaign = params.get("c");
    if (source) out.source = source;
    if (medium) out.medium = medium;
    if (campaign) out.campaign = campaign;
  } catch {
    // URLSearchParams is lenient, but stay total regardless.
  }
  return out;
}

/** Build a `Set-Cookie` value with the shared first-touch attributes. Pass an encoded value to set it (~90d),
 *  or `null` to CLEAR it (`Max-Age=0`, empty value). `domain` (e.g. `.webhook.co`) is omitted in dev/localhost
 *  where a bare host cookie is correct. Usable server-side (a Set-Cookie header) or client-side (document.cookie). */
export function buildFirstTouchCookie(
  value: string | null,
  opts: { domain?: string } = {},
): string {
  const domain = opts.domain ? `; Domain=${opts.domain}` : "";
  const core = value === null ? "=" : `=${value}`;
  const maxAge = value === null ? 0 : FIRST_TOUCH_MAX_AGE_SECONDS;
  return `${FIRST_TOUCH_COOKIE}${core}; Path=/${domain}; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}
