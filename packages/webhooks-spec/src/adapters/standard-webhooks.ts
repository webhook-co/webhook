// Standard Webhooks verify adapter. Standard Webhooks is THE contract for this product
// (ADR-0008); this is the receive-side counterpart to the signer.
//
// Construction (https://www.standardwebhooks.com/, STANDARD_WEBHOOKS_VERSION "v1"):
//   Headers: webhook-id        <msg id>
//            webhook-timestamp <unix seconds>
//            webhook-signature space-delimited list of `v1,<base64>` entries (v1a = asymmetric, skipped)
//   Message: `{id}.{timestamp}.{rawBody}` (dot-joined, header values verbatim).
//   Secret:  `whsec_`-prefixed; the remainder is base64-decoded to the raw HMAC key bytes.
//   MAC:     HMAC-SHA256(key, message), base64-encoded; any v1 entry that matches passes.
//   Skew:    enforce the 300s replay window against webhook-timestamp before any HMAC.
//   Rotation: accept any non-revoked secret (newest first).

import { concatBytes, utf8Encoder } from "../bytes";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import {
  enforceSkew,
  findHeader,
  oversizeBodyFailure,
  toStandardWebhooksCandidates,
  verifyHmacBase64,
} from "./shared";

const SCHEME = "standard_webhooks" as const;
const HEADER = "webhook-signature";
const ID_HEADER = "webhook-id";
const TS_HEADER = "webhook-timestamp";

/** Extract the base64 of each `v1,<base64>` entry from the space-delimited header. v1a is skipped. */
function parseV1Signatures(raw: string): string[] {
  const sigs: string[] = [];
  for (const entry of raw.split(" ")) {
    if (entry === "") continue;
    const comma = entry.indexOf(",");
    if (comma === -1) continue;
    if (entry.slice(0, comma) === "v1") sigs.push(entry.slice(comma + 1));
  }
  return sigs;
}

async function verify(input: VerifyInput): Promise<VerificationResult> {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }

  const oversize = oversizeBodyFailure(SCHEME, input.rawBody);
  if (oversize !== null) return oversize;

  const id = findHeader(input.headers, ID_HEADER);
  if (id === undefined) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `missing ${ID_HEADER}`,
      scheme: SCHEME,
    });
  }
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

  const signatures = parseV1Signatures(headerValue);
  if (signatures.length === 0) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: "no v1 signatures",
      scheme: SCHEME,
    });
  }

  const prefix = utf8Encoder.encode(`${id}.${tsRaw}.`);
  return verifyHmacBase64({
    scheme: SCHEME,
    rawBody: input.rawBody,
    expectedBase64s: signatures,
    candidates: toStandardWebhooksCandidates(input.secrets),
    buildMessage: (body) => concatBytes(prefix, body),
  });
}

export const standardWebhooksAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
