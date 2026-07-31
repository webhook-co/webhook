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
  | "logout"
  | "session_handoff"
  | "session_exchange"
  /**
   * The ONE entry here that does not name a branch this dispatch handles. `POST /api/auth/one-tap/callback`
   * is served by better-auth behind OpenNext; the dispatch throttles it and falls through. It still belongs
   * on this list because it is a public, unauthenticated POST whose only other limiter is better-auth's
   * generic in-memory, per-isolate 100-req/10s — fleet-wide ineffective, the same shape that made the
   * magic-link send need a durable throttle.
   */
  | "one_tap";

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
  logout: { limit: 60, windowSeconds: 60 },
  session_handoff: { limit: 60, windowSeconds: 60 },
  session_exchange: { limit: 60, windowSeconds: 60 },
  // Tighter than /token, and it can afford to be. A One Tap callback is a once-per-sign-in human action,
  // where /token is hit repeatedly by the CLI for refresh — so 30 distinct humans tapping from behind one
  // corporate NAT inside 60s is already an extreme burst. What makes 30 safe rather than merely tight is
  // that this endpoint has three fallbacks on the very same page: a 429 on One Tap leaves the Google
  // button, the GitHub button and magic link all working, so the throttle degrades the convenience and
  // never the ability to sign in. Every other rule here guards a path with no such alternative.
  //
  // What it is defending: on any body carrying a well-formed JWT header, the handler calls
  // `getGooglePublicKey`, a plain uncached fetch to Google's certs endpoint — one outbound subrequest per
  // request, forgeable header and all. (Truly random junk is free: `decodeProtectedHeader` bails before
  // the fetch.) Modest as amplifiers go, but unmetered and attacker-triggerable is the part worth fixing.
  one_tap: { limit: 30, windowSeconds: 60 },
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
