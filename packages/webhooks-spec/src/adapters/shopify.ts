// Shopify verify adapter. Header `X-Shopify-Hmac-Sha256: <base64>`. HMAC-SHA256 over the raw
// request body verbatim, BASE64-encoded (not hex like Stripe/GitHub), keyed by the app's
// client secret (UTF-8). No signed timestamp, so the per-scheme tolerance is carried for
// interface uniformity but never enforced. We compute over the EXACT captured raw bytes,
// compare constant-time over decoded bytes, and accept any non-revoked secret (rotation).
// See https://shopify.dev/docs/apps/build/webhooks/subscribe/https

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { findHeader, oversizeBodyFailure, toCandidates, verifyHmacBase64 } from "./shared";

const SCHEME = "shopify" as const;
const HEADER = "x-shopify-hmac-sha256";

async function verify(input: VerifyInput): Promise<VerificationResult> {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }

  const oversize = oversizeBodyFailure(SCHEME, input.rawBody);
  if (oversize !== null) return oversize;

  return verifyHmacBase64({
    scheme: SCHEME,
    rawBody: input.rawBody,
    expectedBase64s: [headerValue],
    candidates: toCandidates(input.secrets),
    // Shopify signs the raw body verbatim.
    buildMessage: (body) => body,
  });
}

export const shopifyAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
