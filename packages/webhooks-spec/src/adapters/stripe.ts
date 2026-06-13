// Stripe verify adapter. Header `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>…]`.
// Signed payload is `${t}.${rawBody}`, HMAC-SHA256, hex-encoded. We compute over the
// EXACT captured raw bytes, enforce Stripe's 5-minute replay window, and accept any
// non-revoked secret (rotation). See https://stripe.com/docs/webhooks/signatures.

import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../scheme";
import { concatBytes, utf8Encoder } from "../bytes";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { MAX_VERIFIABLE_BODY_BYTES, findHeader, toCandidates, verifyHmacHex } from "./shared";

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

  if (input.rawBody.length > MAX_VERIFIABLE_BODY_BYTES) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: `body exceeds ${MAX_VERIFIABLE_BODY_BYTES} bytes; not verified`,
      scheme: SCHEME,
    });
  }

  const parsed = parseHeader(headerValue);
  if ("error" in parsed) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: parsed.error,
      scheme: SCHEME,
    });
  }

  // Enforce the replay window before spending any HMAC cycles.
  const tolerance = CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME];
  const nowSec = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const skew = nowSec - parsed.timestamp;
  if (skew > tolerance) {
    return verificationFailed({
      code: "TIMESTAMP_TOO_OLD",
      skewSeconds: skew,
      toleranceSeconds: tolerance,
    });
  }
  if (skew < -tolerance) {
    return verificationFailed({
      code: "TIMESTAMP_IN_FUTURE",
      skewSeconds: skew,
      toleranceSeconds: tolerance,
    });
  }

  const candidates = toCandidates(input.secrets);
  const prefix = utf8Encoder.encode(`${parsed.timestamp}.`);
  const buildMessage = (body: Uint8Array): Uint8Array => concatBytes(prefix, body);

  // Try each v1= signature; the first that verifies (or yields a confident diagnosis)
  // wins. We keep the best non-OK result to return if none pass.
  let best: VerificationResult | undefined;
  for (const sig of parsed.signatures) {
    const result = await verifyHmacHex({
      scheme: SCHEME,
      rawBody: input.rawBody,
      expectedHex: sig,
      candidates,
      buildMessage,
    });
    if (result.ok) return result;
    best ??= result;
  }
  return best ?? verificationFailed({ code: "SIGNATURE_MISMATCH" });
}

export const stripeAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
