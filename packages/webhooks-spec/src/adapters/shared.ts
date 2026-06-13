// Shared machinery for the HMAC-over-raw-bytes verify adapters (Stripe, GitHub, …).
// Every adapter computes over the EXACT captured raw bytes (never a re-encoded copy),
// compares constant-time, tries each non-revoked secret (rotation), and — crucially —
// NEVER throws to block an ACK. A verification problem is always returned as a typed
// `VerificationResult` diagnostic, never an exception.

import { bytesToHex, hexToBytes, hmacSha256, timingSafeEqual, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { verificationFailed, verificationOk, type VerificationResult } from "../verification";

/**
 * Upper bound on the raw body we'll verify, in bytes. Past this we don't attempt the
 * HMAC (it's almost certainly not a real provider webhook, and we won't burn CPU on a
 * would-be DoS). 1 MiB comfortably covers documented provider payload ceilings.
 */
export const MAX_VERIFIABLE_BODY_BYTES = 1024 * 1024;

/** SHA-256 MAC is 32 bytes => 64 lowercase hex chars. */
const SHA256_HEX_LENGTH = 64;

/** Case-insensitive header lookup over the ordered, unscrubbed pairs. */
export function findHeader(
  headers: ReadonlyArray<readonly [string, string]>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** A secret paired with the id we report on success (rotation: newest first). */
export interface SecretCandidate {
  readonly keyId: string;
  readonly bytes: Uint8Array;
}

/**
 * Map the caller's `secrets: string[]` (newest first) onto keyed candidates. The keyId
 * we surface is positional (`secret_0` = newest) since the frozen `VerifyInput` carries
 * only the raw strings; a richer keyId can be threaded later without changing this seam.
 */
export function toCandidates(secrets: readonly string[]): SecretCandidate[] {
  return secrets.map((s, i) => ({ keyId: `secret_${i}`, bytes: utf8Encoder.encode(s) }));
}

/** Is `sig` a well-formed lowercase SHA-256 hex digest (right shape, maybe wrong key)? */
function isSha256HexShape(sig: string): boolean {
  return sig.length === SHA256_HEX_LENGTH && /^[0-9a-f]+$/.test(sig);
}

/** Strip a single trailing newline / whitespace run — a classic proxy mutation. */
function stripTrailingWhitespace(body: Uint8Array): Uint8Array | null {
  let end = body.length;
  while (end > 0) {
    const b = body[end - 1]!;
    // space, tab, CR, LF
    if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) end--;
    else break;
  }
  return end === body.length ? null : body.subarray(0, end);
}

/** Re-serialize JSON (parse → compact stringify) — detects a proxy that reformatted the body. */
function reencodeJson(body: Uint8Array): Uint8Array | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return null;
  }
  try {
    const reencoded = JSON.stringify(JSON.parse(text));
    const bytes = utf8Encoder.encode(reencoded);
    return timingSafeEqual(bytes, body) ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Build the signed message bytes for a candidate from the raw body. Stripe prefixes a
 * timestamp (`{t}.{body}`); GitHub signs the raw body verbatim.
 */
export type MessageBuilder = (rawBody: Uint8Array) => Uint8Array;

export interface HmacVerifyParams {
  readonly scheme: WebhookScheme;
  readonly rawBody: Uint8Array;
  readonly expectedHex: string;
  readonly candidates: readonly SecretCandidate[];
  readonly buildMessage: MessageBuilder;
}

/**
 * Core HMAC-SHA256-over-hex verification. Tries every candidate secret against the raw
 * body; on a miss, runs honest body-mutation probes (re-encoded JSON, trailing
 * whitespace) and only then falls back to a shape-based WRONG_SECRET or a plain
 * SIGNATURE_MISMATCH. Returns a diagnostic — it never throws.
 */
export async function verifyHmacHex(params: HmacVerifyParams): Promise<VerificationResult> {
  const { scheme, rawBody, expectedHex, candidates, buildMessage } = params;

  const expectedBytes = hexToBytes(expectedHex.toLowerCase());
  if (expectedBytes === null) {
    return verificationFailed({
      code: "MALFORMED_SIGNATURE",
      detail: "signature is not valid hex",
      scheme,
    });
  }

  if (candidates.length === 0) {
    return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
  }

  // 1) The happy path: does any secret's MAC over the exact raw bytes match?
  const message = buildMessage(rawBody);
  for (const candidate of candidates) {
    const mac = await hmacSha256(candidate.bytes, message);
    if (timingSafeEqual(mac, expectedBytes)) {
      return verificationOk(candidate.keyId, scheme);
    }
  }

  // 2) No match. Probe likely raw-body mutations: if a transformed body matches a
  //    secret, the signature WAS valid for what the sender signed — the bytes changed
  //    in transit. This is a high-signal, honest diagnosis (we proved it).
  const probes: Array<{
    transform: (body: Uint8Array) => Uint8Array | null;
    evidence: "trailing_whitespace" | "reencoded_json";
  }> = [
    { transform: stripTrailingWhitespace, evidence: "trailing_whitespace" },
    { transform: reencodeJson, evidence: "reencoded_json" },
  ];
  for (const probe of probes) {
    const mutated = probe.transform(rawBody);
    if (mutated === null) continue;
    const probeMessage = buildMessage(mutated);
    for (const candidate of candidates) {
      const mac = await hmacSha256(candidate.bytes, probeMessage);
      if (timingSafeEqual(mac, expectedBytes)) {
        return verificationFailed({
          code: "RAW_BODY_MODIFIED",
          confidence: "medium",
          evidence: probe.evidence,
        });
      }
    }
  }

  // 3) Still nothing. If the signature is a well-formed SHA-256 digest, the shape is
  //    right but no secret produced it — most likely a wrong/stale secret. Low
  //    confidence: we can't prove which secret the sender used.
  if (isSha256HexShape(expectedHex.toLowerCase())) {
    return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
  }

  // 4) No confident sub-diagnosis.
  return verificationFailed({ code: "SIGNATURE_MISMATCH" });
}

/** Re-export for adapters that build hex MACs directly (e.g. test/debug seams). */
export { bytesToHex };
