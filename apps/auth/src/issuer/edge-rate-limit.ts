// Per-endpoint, per-client-IP edge rate-limiting for the issuer's public endpoints, applied at the
// issuer-handler dispatch (before the body is read / a pool opened). The provider-owned /register never
// reaches this dispatch — it is throttled separately in the Worker entry (register-guard), before
// provider.fetch. Both sit on the ONE shared throttle (ip-throttle), so the /64 bucketing and the CORS-
// echoed 429 can't drift apart again.

import { throttleByIp, type IpThrottleDeps } from "./ip-throttle";
import type { RateLimitRule } from "./rate-limit";

export type EdgeRateLimitDeps = IpThrottleDeps;

/** The public issuer endpoints gated at the dispatch layer (keys into EDGE_RULES). */
export type EdgeEndpoint =
  | "token"
  | "revoke"
  | "authorize"
  | "consent_decision"
  | "consent_complete"
  | "device_authorization"
  | "device_verify"
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
  // device_verify carries its own per-user-code guess-throttle (which fails CLOSED). That is a correctness
  // gate on guessing a code, not a volume gate on the endpoint — this rule is the volume half.
  device_verify: { limit: 30, windowSeconds: 60 },
  session_handoff: { limit: 60, windowSeconds: 60 },
  session_exchange: { limit: 60, windowSeconds: 60 },
};

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
  return throttleByIp(deps, `edge:${endpoint}`, request, rule, {
    description: "too many requests",
    faultEvent: "edge_rate_limit.fault",
  });
}
