// Standard Webhooks verify adapter — SCAFFOLD (follow-up; fill in the construction).
//
// Standard Webhooks is THE contract for this product (ADR-0008); this adapter is the
// receive-side counterpart to the signer. Do not hand-roll — follow the spec exactly.
//
// Construction (documented, for the follow-up):
//   Headers: webhook-id:        <msg id>
//            webhook-timestamp:  <unix seconds>
//            webhook-signature:  space-separated list of `v1,<base64>` entries
//   Message: `{id}.{timestamp}.{rawBody}` (dot-joined).
//   Secret:  `whsec_`-prefixed, base64-decoded to the raw key bytes.
//   MAC:     HMAC-SHA256(key, message), BASE64-encoded; the header may carry several
//            space-separated signatures — any match passes.
//   Skew:    enforce the per-scheme window against webhook-timestamp (300s).
//   Rotation: accept any non-revoked secret.
//   See https://www.standardwebhooks.com/ and STANDARD_WEBHOOKS_VERSION ("v1").
//
// TODO: implement base64-MAC + `whsec_`/base64 key decode + multi-sig
// header parsing, reusing the timestamp-skew enforcement and rotation machinery. Until
// then this returns an honest UNSUPPORTED_SCHEME so capture/ACK is never blocked.

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { findHeader } from "./shared";

const SCHEME = "standard_webhooks" as const;
const HEADER = "webhook-signature";

function verify(input: VerifyInput): VerificationResult {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }
  // Scaffold: construction not yet implemented. Diagnose rather than throw.
  return verificationFailed({ code: "UNSUPPORTED_SCHEME", observedHeaders: [HEADER] });
}

export const standardWebhooksAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
