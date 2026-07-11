// Durable per-IP rate-limit on the provider-owned DCR endpoint (POST /register). Open DCR is public and
// unauthenticated: without this an attacker can flood it, writing unbounded permanent `client:<id>` KV
// records (storage/cost amplification) and minting registered clients as phishing vehicles. The provider
// serves /register itself (it never reaches the issuer-handler dispatch where edgeRateLimit runs), so this
// guard is invoked in the Worker entry BEFORE delegating to provider.fetch.
//
// Bucketed by the client IP, with IPv6 truncated to its /64 (a single allocation an attacker fully
// controls — counting per-full-address would be trivially evaded by rotating the low 64 bits). FAILS OPEN
// (unbound KV / absent IP / KV fault → allow): this is a volume throttle on a legitimate public endpoint,
// not a guess-limiter, so it must never block real traffic on the limiter itself. clientRegistrationTTL
// (set in oauth-config) bounds how long any registered client — junk or real — survives.

import { consumeRateLimit, type RateLimitKv, type RateLimitRule } from "./rate-limit";

/** Generous for a human adding an MCP server (Claude Code re-registers per login), tight against a flood. */
export const REGISTER_RATE_RULE: RateLimitRule = { limit: 30, windowSeconds: 60 };

/**
 * The rate-limit bucket for a client IP. IPv4 is used whole; IPv6 is truncated to its /64 prefix (the
 * first four hextets), expanding a `::`-compressed address first so equivalent forms collapse to one key.
 */
export function ipRateBucket(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4
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

export interface RegisterGuardDeps {
  /** The rate-limit KV (RATELIMIT_KV). Undefined when unbound (dev/test) → the gate is skipped. */
  kv: RateLimitKv | undefined;
  nowSeconds: () => number;
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", error_description: "too many registration requests" }),
    {
      status: 429,
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "retry-after": String(retryAfterSeconds),
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Throttle POST /register per client IP. Returns a 429 Response to short-circuit (the Worker returns it
 * instead of calling provider.fetch), or null to proceed. A non-/register request, an unbound KV, an
 * absent cf-connecting-ip, or a KV fault all return null (fail open).
 */
export async function guardRegister(
  deps: RegisterGuardDeps,
  request: Request,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (pathname !== "/register") return null;
  if (!deps.kv) return null;
  // cf-connecting-ip is CF-set + not client-spoofable at the Worker. Absent only off-edge → fail open
  // rather than collapse every header-less request into one poisonable bucket.
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  try {
    const result = await consumeRateLimit(
      { kv: deps.kv, nowSeconds: deps.nowSeconds },
      `register:ip:${ipRateBucket(ip)}`,
      REGISTER_RATE_RULE,
    );
    return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
  } catch (error) {
    console.log(JSON.stringify({ message: "register_rate_limit.fault", error: String(error) }));
    return null;
  }
}
