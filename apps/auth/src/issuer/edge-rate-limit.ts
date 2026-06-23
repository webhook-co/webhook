// Per-endpoint, per-client-IP edge rate-limiting for the issuer's public endpoints — the in-Worker layer of
// the deferred "edge rate-limit on auth. sensitive paths". A coarse Cloudflare WAF rate-limit rule is the
// outer layer (and covers provider-owned /register, which never reaches this dispatch); this is the precise,
// per-endpoint inner layer applied at the issuer-handler dispatch (before the body is read / a pool opened).
//
// Reuses the durable fixed-window `consumeRateLimit` (rate-limit.ts), keyed by `<endpoint>:ip:<ip>`. FAILS
// OPEN — unlike the device-verify guess-throttle (which fails closed), these are VOLUME throttles on the
// token/login paths, so a KV outage or an unbound binding must NOT block legitimate traffic. Over-limit →
// 429 + Retry-After.

import { consumeRateLimit, type RateLimitKv, type RateLimitRule } from "./rate-limit";

export interface EdgeRateLimitDeps {
  /** The rate-limit KV (RATELIMIT_KV). Undefined when unbound (dev/test) → the gate is skipped. */
  kv: RateLimitKv | undefined;
  nowSeconds: () => number;
}

/** The public issuer endpoints gated at the dispatch layer (keys into EDGE_RULES). */
export type EdgeEndpoint =
  | "token"
  | "revoke"
  | "authorize"
  | "consent_decision"
  | "consent_complete"
  | "device_authorization"
  | "session_handoff"
  | "session_exchange";

// Coarse per-IP-per-minute ceilings — generous for legitimate use (a human consent flow, a CLI token
// exchange), tight enough to blunt a flood. windowSeconds is KV's 60s minimum. Tune from observability.
export const EDGE_RULES: Record<EdgeEndpoint, RateLimitRule> = {
  token: { limit: 60, windowSeconds: 60 },
  revoke: { limit: 60, windowSeconds: 60 },
  authorize: { limit: 120, windowSeconds: 60 },
  consent_decision: { limit: 60, windowSeconds: 60 },
  consent_complete: { limit: 120, windowSeconds: 60 },
  device_authorization: { limit: 30, windowSeconds: 60 },
  session_handoff: { limit: 60, windowSeconds: 60 },
  session_exchange: { limit: 60, windowSeconds: 60 },
};

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", error_description: "too many requests" }),
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
 * Consume one unit for `(endpoint, client-IP)`. Returns a 429 Response to short-circuit when over the rule,
 * or null to proceed. Fails OPEN (→ null) when the KV is unbound OR errors — the gate never blocks a
 * legitimate request on the limiter itself; over-limit denial is the only blocking path.
 */
export async function edgeRateLimit(
  deps: EdgeRateLimitDeps,
  endpoint: EdgeEndpoint,
  request: Request,
  rule: RateLimitRule,
): Promise<Response | null> {
  if (!deps.kv) return null; // unbound (dev/test) → skip
  // cf-connecting-ip is CF-set + not client-spoofable at the Worker. Absent only off-edge (dev/test); when
  // it is, FAIL OPEN rather than collapse every header-less request into one poisonable `:ip:unknown` bucket.
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return null;
  try {
    const result = await consumeRateLimit(
      { kv: deps.kv, nowSeconds: deps.nowSeconds },
      `edge:${endpoint}:ip:${ip}`,
      rule,
    );
    return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
  } catch (error) {
    // Fail open on a KV fault — never block legit traffic on the limiter — but leave an observability
    // breadcrumb so a KV outage silently disabling the gate fleet-wide is diagnosable.
    console.log(
      JSON.stringify({ message: "edge_rate_limit.fault", endpoint, error: String(error) }),
    );
    return null;
  }
}
