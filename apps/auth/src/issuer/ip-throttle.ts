// The one per-client-IP volume throttle shared by every public issuer endpoint — the provider-owned
// POST /register (register-guard, in the Worker entry) and the issuer-handler dispatch (edge-rate-limit).
// These two grew independently and drifted: the register guard bucketed IPv6 by /64 and echoed CORS on its
// 429, the edge gate did neither. Both behaviours are load-bearing, so they live here once and both callers
// get them.
//
// FAILS OPEN (unbound KV / absent client IP / KV fault → allow). These are VOLUME throttles on legitimate
// public endpoints, not guess-limiters (the device-verify code-guess throttle fails closed, separately) —
// a KV outage must never lock users out of signing in. Over-limit denial is the only blocking path.

import { consumeRateLimit, type RateLimitKv, type RateLimitRule } from "./rate-limit";

export interface IpThrottleDeps {
  /** The rate-limit KV (RATELIMIT_KV). Undefined when unbound (dev/test) → the gate is skipped. */
  kv: RateLimitKv | undefined;
  nowSeconds: () => number;
}

/**
 * The rate-limit bucket for a client IP. IPv4 (incl. an IPv4-mapped `::ffff:a.b.c.d`) is used whole; a real
 * IPv6 address is truncated to its /64 prefix (the first four hextets), expanding a `::`-compressed address
 * first so equivalent forms collapse to one key.
 *
 * The /64 is the unit an attacker actually controls — a consumer IPv6 allocation is a whole /64, so keying
 * on the full address makes any limit free to evade by rotating the low 64 bits.
 *
 * This matches on the hextet TEXT, so it relies on the input already being canonical (lowercase, zero-
 * suppressed, `::`-compressed) — which `cf-connecting-ip` always is, and which is the ONLY source we key on
 * (it is CF-set + not client-spoofable at the Worker). If the IP source ever changes to a client-influenced
 * header (x-forwarded-for), normalize each hextet through `parseInt(g, 16)` first, or the text-compare
 * becomes evadable.
 */
export function ipRateBucket(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4
  // An IPv4-mapped IPv6 address is really an IPv4 client — bucket by the embedded IPv4, else the naive /64
  // slice would collapse EVERY mapped address to the single all-zero prefix and share one bucket.
  const mappedIpv4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip)?.[1];
  if (mappedIpv4) return mappedIpv4;
  const [head, tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  return groups
    .slice(0, 4)
    .map((g) => g || "0")
    .join(":");
}

/**
 * A 429 for an over-limit request. Mirrors the CORS the provider attaches to its own responses (an echoed
 * Origin) so a cross-origin browser MCP client can READ the response — without it the browser surfaces an
 * opaque CORS error and the client fails silently, never seeing the Retry-After it is meant to honour.
 * CORS headers are only added when the request carries an Origin.
 */
function tooManyRequests(
  retryAfterSeconds: number,
  request: Request,
  description: string,
): Response {
  const headers = new Headers({
    "content-type": "application/json;charset=UTF-8",
    "retry-after": String(retryAfterSeconds),
    "cache-control": "no-store",
  });
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "*");
    headers.set("access-control-allow-headers", "Authorization, *");
  }
  return new Response(JSON.stringify({ error: "rate_limited", error_description: description }), {
    status: 429,
    headers,
  });
}

/**
 * Consume one unit for `(scope, client-IP-bucket)`. Returns a 429 Response to short-circuit, or null to
 * proceed. `scope` namespaces the bucket (e.g. `register`, `edge:token`); `faultEvent` names the structured
 * log emitted if the KV faults, so a limiter silently disabled fleet-wide stays diagnosable.
 */
export async function throttleByIp(
  deps: IpThrottleDeps,
  scope: string,
  request: Request,
  rule: RateLimitRule,
  { description, faultEvent }: { description: string; faultEvent: string },
): Promise<Response | null> {
  if (!deps.kv) return null; // unbound (dev/test) → skip
  // cf-connecting-ip is CF-set + not client-spoofable at the Worker. Absent only off-edge (dev/test); when
  // it is, FAIL OPEN rather than collapse every header-less request into one poisonable `:ip:unknown` bucket.
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  try {
    const result = await consumeRateLimit(
      { kv: deps.kv, nowSeconds: deps.nowSeconds },
      `${scope}:ip:${ipRateBucket(ip)}`,
      rule,
    );
    return result.allowed ? null : tooManyRequests(result.retryAfterSeconds, request, description);
  } catch (error) {
    console.log(JSON.stringify({ message: faultEvent, scope, error: String(error) }));
    return null;
  }
}
