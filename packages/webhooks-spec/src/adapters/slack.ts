// Slack verify adapter.
//   Headers: X-Slack-Request-Timestamp <unix seconds>
//            X-Slack-Signature          v0=<hex>
//   Message: `v0:{timestamp}:{rawBody}` (colon-joined, literal `v0`, raw body verbatim).
//   MAC:     HMAC-SHA256(signingSecret, message), hex-encoded, header prefixed `v0=`.
//   Skew:    reject timestamps outside the 300s window (replay defense) before any HMAC.
//   Rotation: accept any non-revoked signing secret (newest first).
//   See https://docs.slack.dev/authentication/verifying-requests-from-slack

import { concatBytes, utf8Encoder } from "../bytes";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import {
  enforceSkew,
  findHeader,
  oversizeBodyFailure,
  toCandidates,
  verifyHmacHex,
} from "./shared";

const SCHEME = "slack" as const;
const HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";
const PREFIX = "v0=";

async function verify(input: VerifyInput): Promise<VerificationResult> {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }

  const oversize = oversizeBodyFailure(SCHEME, input.rawBody);
  if (oversize !== null) return oversize;

  if (!headerValue.startsWith(PREFIX)) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `expected "${PREFIX}" prefix`,
      scheme: SCHEME,
    });
  }
  const expectedHex = headerValue.slice(PREFIX.length);

  const tsRaw = findHeader(input.headers, TS_HEADER);
  if (tsRaw === undefined) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `missing ${TS_HEADER}`,
      scheme: SCHEME,
    });
  }
  const tsNum = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(tsNum) || String(tsNum) !== tsRaw) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `non-integer ${TS_HEADER}`,
      scheme: SCHEME,
    });
  }

  // Enforce the replay window before spending any HMAC cycles.
  const skewFailure = enforceSkew(SCHEME, tsNum, input.now);
  if (skewFailure !== null) return skewFailure;

  const prefix = utf8Encoder.encode(`v0:${tsRaw}:`);
  return verifyHmacHex({
    scheme: SCHEME,
    rawBody: input.rawBody,
    expectedHexes: [expectedHex],
    candidates: toCandidates(input.secrets),
    buildMessage: (body) => concatBytes(prefix, body),
  });
}

export const slackAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
