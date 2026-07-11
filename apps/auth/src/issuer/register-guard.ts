// Durable per-IP rate-limit on the provider-owned DCR endpoint (POST /register). Open DCR is public and
// unauthenticated: without this an attacker can flood it, writing unbounded permanent `client:<id>` KV
// records (storage/cost amplification) and minting registered clients as phishing vehicles. The provider
// serves /register itself (it never reaches the issuer-handler dispatch where edgeRateLimit runs), so this
// guard is invoked in the Worker entry BEFORE delegating to provider.fetch.
//
// The bucketing, the CORS-echoed 429, and the fail-open ladder all live in the shared throttle
// (ip-throttle) — the same one the edge gate uses. clientRegistrationTTL (set in oauth-config) bounds how
// long any registered client — junk or real — survives.

import { throttleByIp, type IpThrottleDeps } from "./ip-throttle";
import type { RateLimitRule } from "./rate-limit";

// Generous, because registration is rare per user and web MCP clients (claude.ai / cursor.com) may DCR
// from a small pool of SHARED vendor egress IPs — a tight limit would false-429 legitimate concurrent
// onboarding from one /64. Storage is bounded by clientRegistrationTTL and a client is inert without
// consent, so this just blunts a naive flood; it doesn't need to be tight.
export const REGISTER_RATE_RULE: RateLimitRule = { limit: 60, windowSeconds: 60 };

export type RegisterGuardDeps = IpThrottleDeps;

// Re-exported so register-guard.test.ts can exercise the IPv6 /64 bucketing where it was first specified.
export { ipRateBucket } from "./ip-throttle";

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
  return throttleByIp(deps, "register", request, REGISTER_RATE_RULE, {
    description: "too many registration requests",
    faultEvent: "register_rate_limit.fault",
  });
}
