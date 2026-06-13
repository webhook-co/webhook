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

// Rank non-OK diagnoses by how informative they are (higher = more informative), so the
// best reason across multiple v1= entries is the one returned. A proven body mutation beats
// a shape-based guess beats a generic miss beats "this v1= wasn't even valid hex".
const FAILURE_RANK: Record<string, number> = {
  RAW_BODY_MODIFIED: 5, // we PROVED the bytes changed in transit
  WRONG_SECRET: 4, // right shape, but no configured secret matched
  SIGNATURE_MISMATCH: 3, // generic crypto miss
  NO_MATCHING_KEY: 2, // no secrets configured to try
  MALFORMED_SIGNATURE: 1, // this v1= value wasn't valid hex
};
function failureRank(result: VerificationResult): number {
  return result.ok ? -1 : (FAILURE_RANK[result.reason.code] ?? 0);
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

  // Try each v1= signature; the first that verifies wins. If none pass, keep the MOST
  // INFORMATIVE non-OK diagnosis across the entries — not merely the first — so a specific,
  // proven reason (e.g. RAW_BODY_MODIFIED from one v1=) isn't hidden behind a generic or
  // malformed one from an earlier entry.
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
    if (best === undefined || failureRank(result) > failureRank(best)) best = result;
  }
  return best ?? verificationFailed({ code: "SIGNATURE_MISMATCH" });
}

export const stripeAdapter: VerifyAdapter = {
  scheme: SCHEME,
  signatureHeader: HEADER,
  toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS[SCHEME],
  verify,
};
