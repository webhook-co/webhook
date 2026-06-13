// Shopify verify adapter — SCAFFOLD (WS-A follow-up; fill in the construction).
//
// Construction (documented, for the next workstream):
//   Header:  X-Shopify-Hmac-Sha256: <base64>
//   Message: the raw request body verbatim (no timestamp).
//   MAC:     HMAC-SHA256(secret, rawBody), BASE64-encoded (NOT hex like Stripe/GitHub).
//   Compare: constant-time over the decoded MAC bytes.
//   No signed timestamp => toleranceSeconds is carried for uniformity, not enforced.
//   Rotation: accept any non-revoked secret.
//   See https://shopify.dev/docs/apps/webhooks/configuration/https#verify-webhook
//
// TODO(ws-a-followup): implement base64-MAC verification. `verifyHmacHex` in ./shared
// assumes a hex digest; add a base64 sibling (or generalize the encoding) and reuse the
// same mutation-probe + rotation machinery. Until then this returns an honest
// UNSUPPORTED_SCHEME so capture/ACK is never blocked.

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { findHeader } from "./shared";

const SCHEME = "shopify" as const;
const HEADER = "x-shopify-hmac-sha256";

function verify(input: VerifyInput): VerificationResult {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }
  // Scaffold: construction not yet implemented. Diagnose rather than throw — capture
  // and ACK must never block on a missing adapter implementation (§0.5).
  return verificationFailed({ code: "UNSUPPORTED_SCHEME", observedHeaders: [HEADER] });
}

export const shopifyAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
