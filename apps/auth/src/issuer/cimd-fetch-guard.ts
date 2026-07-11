// A tighter per-IP throttle on the CIMD-fetch path. When a client presents a URL-shaped client_id (CIMD),
// the provider FETCHES that URL inside parseAuthRequest — and parseAuthRequest runs BEFORE the session
// check on GET /authorize, so an UNAUTHENTICATED caller can make auth.webhook.co issue an outbound request
// to an arbitrary public URL (a fetch reflector; the SSRF flag blocks only private targets). The generic
// `authorize` edge limit (120/min) already bounds this, but a CIMD authorize is far rarer for a legit user
// than a normal one, so we add a much tighter ceiling ON TOP, applied only when the client_id is a CIMD URL.
//
// Pure decision (isCimdAuthorizeRequest) + the rule; the throttle itself is the shared edge limiter, wired
// in the issuer-handler GET /authorize branch before the pool opens / the provider fetches.

import { isCimdClientId } from "./dcr";
import type { RateLimitRule } from "./rate-limit";

// A legit user initiates only a handful of CIMD authorizations a minute (each is a full browser consent
// flow). 20/min/·64 is generous for that yet tightly bounds an unauthenticated caller trying to drive the
// fetch path. It sits UNDER the generic authorize limit (120/min), so it's the binding one for CIMD.
export const CIMD_AUTHORIZE_RULE: RateLimitRule = { limit: 20, windowSeconds: 60 };

/**
 * Is this request a `GET /authorize` whose `client_id` is a CIMD URL (→ the provider will fetch it)? A
 * malformed URL, a missing/opaque client_id, or any non-GET /authorize request returns false. Pure: reads
 * only the request URL, so it's safe to call before any pool/session work.
 */
export function isCimdAuthorizeRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.pathname !== "/authorize") return false;
  const clientId = url.searchParams.get("client_id");
  return clientId !== null && isCimdClientId(clientId);
}
