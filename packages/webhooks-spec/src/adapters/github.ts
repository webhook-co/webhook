// GitHub verify adapter. Header `X-Hub-Signature-256: sha256=<hex>`. HMAC-SHA256 over
// the raw body verbatim, hex-encoded. No signed timestamp, so the per-scheme tolerance
// is carried for interface uniformity but never enforced. We compute over the EXACT
// captured raw bytes and accept any non-revoked secret (rotation).
// See https://docs.github.com/webhooks/securing-your-webhooks.

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { MAX_VERIFIABLE_BODY_BYTES, findHeader, toCandidates, verifyHmacHex } from "./shared";

const SCHEME = "github" as const;
const HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";

async function verify(input: VerifyInput): Promise<VerificationResult> {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }

  if (input.rawBody.length > MAX_VERIFIABLE_BODY_BYTES) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `body exceeds ${MAX_VERIFIABLE_BODY_BYTES} bytes; not verified`,
      scheme: SCHEME,
    });
  }

  if (!headerValue.startsWith(PREFIX)) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `expected "${PREFIX}" prefix`,
      scheme: SCHEME,
    });
  }
  const expectedHex = headerValue.slice(PREFIX.length);

  return verifyHmacHex({
    scheme: SCHEME,
    rawBody: input.rawBody,
    expectedHex,
    candidates: toCandidates(input.secrets),
    // GitHub signs the raw body verbatim.
    buildMessage: (body) => body,
  });
}

export const githubAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
