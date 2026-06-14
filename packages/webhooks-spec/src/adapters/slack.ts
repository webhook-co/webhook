// Slack verify adapter — SCAFFOLD (follow-up; fill in the construction).
//
// Construction (documented, for the follow-up):
//   Headers: X-Slack-Request-Timestamp: <unix seconds>
//            X-Slack-Signature: v0=<hex>
//   Message: `v0:{timestamp}:{rawBody}` (colon-joined, with the literal version tag).
//   MAC:     HMAC-SHA256(signingSecret, message), hex-encoded, prefixed `v0=`.
//   Skew:    reject timestamps older than the per-scheme window (replay defense, 300s).
//   Rotation: accept any non-revoked signing secret.
//   See https://api.slack.com/authentication/verifying-requests-from-slack
//
// TODO: implement. This is close to the Stripe shape — reuse
// `verifyHmacHex` from ./shared with a `buildMessage` of `v0:{ts}:` + rawBody and the
// same timestamp-skew enforcement Stripe does. Until then, return an honest
// UNSUPPORTED_SCHEME so capture/ACK is never blocked.

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { findHeader } from "./shared";

const SCHEME = "slack" as const;
const HEADER = "x-slack-signature";

function verify(input: VerifyInput): VerificationResult {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }
  // Scaffold: construction not yet implemented. Diagnose rather than throw.
  return verificationFailed({ code: "UNSUPPORTED_SCHEME", observedHeaders: [HEADER] });
}

export const slackAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
