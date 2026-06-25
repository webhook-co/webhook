// Stripe verify adapter. Header `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>…]`.
// Signed payload is `${t}.${rawBody}`, HMAC-SHA256, hex-encoded. We compute over the
// EXACT captured raw bytes, enforce Stripe's 5-minute replay window, and accept any
// non-revoked secret against any v1= entry (rotation). See https://stripe.com/docs/webhooks/signatures.

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

const SCHEME = "stripe" as const;
const HEADER = "stripe-signature";

interface ParsedStripeHeader {
  readonly timestamp: number;
  readonly signatures: string[];
}

/** Parse `t=…,v1=…` pairs. Returns a diagnostic string on malformed input. */
function parseHeader(raw: string): ParsedStripeHeader | { error: string } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || String(n) !== value) return { error: "non-integer t" };
      timestamp = n;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === undefined) return { error: "missing t=" };
  if (signatures.length === 0) return { error: "missing v1=" };
  return { timestamp, signatures };
}

async function verify(input: VerifyInput): Promise<VerificationResult> {
  const headerValue = findHeader(input.headers, HEADER);
  if (headerValue === undefined) {
    return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: SCHEME });
  }

  const oversize = oversizeBodyFailure(SCHEME, input.rawBody);
  if (oversize !== null) return oversize;

  const parsed = parseHeader(headerValue);
  if ("error" in parsed) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: parsed.error,
      scheme: SCHEME,
    });
  }

  // Enforce the replay window before spending any HMAC cycles.
  const skewFailure = enforceSkew(SCHEME, parsed.timestamp, input.now);
  if (skewFailure !== null) return skewFailure;

  const prefix = utf8Encoder.encode(`${parsed.timestamp}.`);
  return verifyHmacHex({
    scheme: SCHEME,
    rawBody: input.rawBody,
    expectedHexes: parsed.signatures,
    candidates: toCandidates(input.secrets),
    buildMessage: (body) => concatBytes(prefix, body),
  });
}

export const stripeAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
