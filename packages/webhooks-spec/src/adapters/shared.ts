// Shared machinery for the HMAC-over-raw-bytes verify adapters (Stripe, GitHub, Slack,
// Shopify, Standard Webhooks). Every adapter computes over the EXACT captured raw bytes
// (never a re-encoded copy), compares constant-time over decoded bytes, tries each
// non-revoked secret (rotation), and — crucially — NEVER throws to block an ACK. A
// verification problem is always returned as a typed `VerificationResult` diagnostic.
//
// Encoding + digest seam: schemes carry their MAC as hex / base64 / base64url, under HMAC with
// SHA-256 (most), SHA-1, or SHA-512. `verifyHmacCore` is the single audited rotation +
// mutation-probe engine — MULTI-SIGNATURE aware (it takes the full list of expected signatures
// from the header) and digest-parameterized. `verifyHmac` is the general entry (it picks the
// decoder by encoding and the hash/MAC-length by digest); `verifyHmacHex` / `verifyHmacBase64`
// are thin SHA-256 specializations kept for their direct unit tests.

import {
  b64ToBytes,
  b64urlToBytes,
  bytesToHex,
  hexToBytes,
  type HmacHash,
  importHmacKeyForHash,
  timingSafeEqual,
  utf8Encoder,
} from "../bytes";
import { CLOCK_SKEW_TOLERANCE_SECONDS, type WebhookScheme } from "../scheme";
import { verificationFailed, verificationOk, type VerificationResult } from "../verification";
import type { HmacDigest, SignatureEncoding } from "./config";

/**
 * Upper bound on the raw body we'll verify, in bytes. Past this we don't attempt the
 * HMAC (it's almost certainly not a real provider webhook, and we won't burn CPU on a
 * would-be DoS). 1 MiB comfortably covers documented provider payload ceilings.
 */
export const MAX_VERIFIABLE_BODY_BYTES = 1024 * 1024;

/**
 * Per-digest engine parameters: the SubtleCrypto hash to import the key under, and the EXACT MAC
 * byte length (a decoded signature of any other length can't possibly match, so it's filtered out
 * before any crypto). SHA-1 = 20 bytes, SHA-256 = 32, SHA-512 = 64.
 */
const DIGEST_PARAMS: Readonly<Record<HmacDigest, { hash: HmacHash; macBytes: number }>> = {
  sha1: { hash: "SHA-1", macBytes: 20 },
  sha256: { hash: "SHA-256", macBytes: 32 },
  sha512: { hash: "SHA-512", macBytes: 64 },
};

/** The Standard Webhooks secret prefix; the remainder is base64-decoded to the raw key. */
const WHSEC_PREFIX = "whsec_";

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

/**
 * Reject an over-cap body uniformly across adapters (a scheme-independent guard, so it lives
 * here rather than copy-pasted into each verify()). Returns a diagnostic if too large, else null.
 */
export function oversizeBodyFailure(
  scheme: WebhookScheme,
  rawBody: Uint8Array,
): VerificationResult | null {
  if (rawBody.length <= MAX_VERIFIABLE_BODY_BYTES) return null;
  return verificationFailed({
    code: "MALFORMED_SIGNATURE",
    detail: `body exceeds ${MAX_VERIFIABLE_BODY_BYTES} bytes; not verified`,
    scheme,
  });
}

/** A secret paired with the id we report on success (rotation: newest first). */
export interface SecretCandidate {
  readonly keyId: string;
  readonly bytes: Uint8Array;
}

/**
 * Map the caller's `secrets: string[]` (newest first) onto keyed candidates, using each
 * secret string as the UTF-8 key bytes (Stripe/GitHub/Slack/Shopify). A zero-length key would
 * make crypto.subtle.importKey throw, so empty secrets are skipped (dropped, not fatal) — a
 * misconfigured empty secret can never throw into the capture path. Positional keyId kept
 * (`secret_0` = newest) since the frozen `VerifyInput` carries only the raw strings.
 */
export function toCandidates(secrets: readonly string[]): SecretCandidate[] {
  const out: SecretCandidate[] = [];
  secrets.forEach((s, i) => {
    const bytes = utf8Encoder.encode(s);
    if (bytes.length > 0) out.push({ keyId: `secret_${i}`, bytes });
  });
  return out;
}

/**
 * Normalize a Standard-Webhooks secret to its base64 key material: strip an optional leading version
 * tag — Supabase displays its secret as `v1,whsec_<base64>` — and the optional `whsec_` prefix. A real
 * base64 secret contains no comma, so a leading `v<n>,` is unambiguously a version tag, not key bytes;
 * a bare-base64 secret (e.g. Brex, no prefix at all) passes through unchanged.
 */
function standardWebhooksSecretB64(secret: string): string {
  const untagged = secret.replace(/^v\d+,/, "");
  return untagged.startsWith(WHSEC_PREFIX) ? untagged.slice(WHSEC_PREFIX.length) : untagged;
}

/**
 * Map Standard Webhooks secrets onto keyed candidates. Unlike the UTF-8 schemes, an SW secret is a
 * (optionally `whsec_`-prefixed, optionally `v1,`-tagged) base64 string, decoded to the RAW key bytes.
 * Non-base64 or zero-length keys are skipped (never throws); positional keyIds keep their original
 * index so `secret_0` still maps to the newest provided secret.
 */
export function toStandardWebhooksCandidates(secrets: readonly string[]): SecretCandidate[] {
  const out: SecretCandidate[] = [];
  secrets.forEach((s, i) => {
    const bytes = b64ToBytes(standardWebhooksSecretB64(s));
    if (bytes !== null && bytes.length > 0) out.push({ keyId: `secret_${i}`, bytes });
  });
  return out;
}

/**
 * Is a registered Standard Webhooks secret USABLE — i.e. does it decode to a non-empty key the verify
 * path can actually use? A SW secret is `whsec_`+base64; the verify path strips the prefix and base64-
 * decodes the remainder (toStandardWebhooksCandidates, above) to get the raw key. This applies the SAME
 * decoder, so registration accepts a secret IFF verification can decode it — closing the gap where a
 * value that merely matches the base64 *alphabet* but is not valid base64 (e.g. a length ≡ 1 mod 4
 * paste, or hex/raw) would register yet decode to nothing, then verify as NO_MATCHING_KEY forever
 * (indistinguishable from "no secret"). Registration callers use this to reject a mis-stored secret up
 * front with a real error. Pure (no I/O); the single source of "is this SW secret decodable".
 */
export function isUsableStandardWebhooksSecret(secret: string): boolean {
  const bytes = b64ToBytes(standardWebhooksSecretB64(secret));
  return bytes !== null && bytes.length > 0;
}

/**
 * Enforce a scheme's replay window against a signed unix-seconds timestamp. Returns a typed
 * failure if outside tolerance, else null. Call BEFORE spending any HMAC cycles. Shared by the
 * timestamped schemes (Stripe, Slack, Standard Webhooks).
 */
export function enforceSkew(
  scheme: WebhookScheme,
  timestampSeconds: number,
  now?: Date,
): VerificationResult | null {
  const tolerance = CLOCK_SKEW_TOLERANCE_SECONDS[scheme];
  const nowMs = now?.getTime() ?? Date.now();
  // An Invalid Date (getTime() === NaN) must NOT silently disable the replay check — every NaN
  // comparison is false, which would skip the window entirely. Fall back to real time.
  const nowSec = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  const skew = nowSec - timestampSeconds;
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
  return null;
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

/** Honest body-mutation probes: a probe match proves the bytes changed in transit, not the key. */
const PROBES: ReadonlyArray<{
  readonly transform: (body: Uint8Array) => Uint8Array | null;
  readonly evidence: "trailing_whitespace" | "reencoded_json";
}> = [
  { transform: stripTrailingWhitespace, evidence: "trailing_whitespace" },
  { transform: reencodeJson, evidence: "reencoded_json" },
];

/**
 * Build the signed message bytes for a candidate from the raw body. Stripe prefixes a
 * timestamp (`{t}.{body}`); GitHub/Shopify sign the raw body verbatim; Slack and Standard
 * Webhooks prefix their own framing.
 */
export type MessageBuilder = (rawBody: Uint8Array) => Uint8Array;

/** Decode an encoded signature string to MAC bytes; null on malformed input (never throws). */
type SignatureDecoder = (sig: string) => Uint8Array | null;

interface HmacCoreParams {
  readonly scheme: WebhookScheme;
  readonly rawBody: Uint8Array;
  /** Every expected signature from the header (normalized: hex lowercased, base64 as-is). */
  readonly expectedSigs: readonly string[];
  readonly decode: SignatureDecoder;
  /** Diagnostic detail when a signature is un-decodable (encoding-specific). */
  readonly malformedDetail: string;
  /** The HMAC digest (selects the key-import hash + the matchable MAC length). */
  readonly digest: HmacDigest;
  readonly candidates: readonly SecretCandidate[];
  readonly buildMessage: MessageBuilder;
}

/**
 * The single audited HMAC verification engine, digest- and multi-signature-aware. Decodes every
 * expected signature once and keeps the matchable (correct-length-for-the-digest) ones; imports each
 * candidate key once under the digest's hash; computes each candidate's MAC once and compares it
 * against ALL expected signatures (O(candidates), not O(candidates × signatures)). On a miss, runs
 * honest body-mutation probes (trailing whitespace, re-encoded JSON) before falling back to
 * WRONG_SECRET (a correct-length signature was present but unmatched) or SIGNATURE_MISMATCH /
 * MALFORMED_SIGNATURE. Never throws.
 */
async function verifyHmacCore(params: HmacCoreParams): Promise<VerificationResult> {
  const {
    scheme,
    rawBody,
    expectedSigs,
    decode,
    malformedDetail,
    digest,
    candidates,
    buildMessage,
  } = params;
  const { hash, macBytes } = DIGEST_PARAMS[digest];

  // Decode every expected signature once. A MAC is exactly `macBytes` for this digest, so only
  // correct-length decodes are matchable; track whether ANY signature decoded at all (vs all
  // un-decodable/empty).
  const expected: Uint8Array[] = [];
  let sawDecodable = false;
  for (const sig of expectedSigs) {
    const bytes = decode(sig);
    if (bytes === null || bytes.length === 0) continue;
    sawDecodable = true;
    if (bytes.length === macBytes) expected.push(bytes);
  }

  // Diagnosis precedence mirrors the per-signature pipeline these adapters had before the engine
  // became multi-sig aware: (a) nothing decodable at all → MALFORMED; (b) no usable key →
  // NO_MATCHING_KEY (before any crypto verdict); (c) decodable but no correct-length (for the digest)
  // signature → can't possibly match → SIGNATURE_MISMATCH.
  if (!sawDecodable) {
    return verificationFailed({ code: "MALFORMED_SIGNATURE", detail: malformedDetail, scheme });
  }
  if (candidates.length === 0) {
    return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
  }
  if (expected.length === 0) {
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  // Import each candidate key once under the digest's hash (reused across the happy message + every
  // probe + every expected signature) — bytes.ts documents not re-importing per request.
  const keyed = await Promise.all(
    candidates.map(async (c) => ({
      keyId: c.keyId,
      key: await importHmacKeyForHash(c.bytes, hash),
    })),
  );

  // 1) The happy path: does any secret's MAC over the exact raw bytes match any expected sig?
  const message = buildMessage(rawBody);
  for (const c of keyed) {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", c.key, message));
    for (const exp of expected) {
      if (timingSafeEqual(mac, exp)) return verificationOk(c.keyId, scheme);
    }
  }

  // 2) No match. Probe likely raw-body mutations: a transformed body matching a secret proves
  //    the signature WAS valid for what the sender signed — the bytes changed in transit.
  for (const probe of PROBES) {
    const mutated = probe.transform(rawBody);
    if (mutated === null) continue;
    const probeMessage = buildMessage(mutated);
    for (const c of keyed) {
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", c.key, probeMessage));
      for (const exp of expected) {
        if (timingSafeEqual(mac, exp)) {
          return verificationFailed({
            code: "RAW_BODY_MODIFIED",
            confidence: "medium",
            evidence: probe.evidence,
          });
        }
      }
    }
  }

  // 3) Matchable signatures were present but no configured secret produced any of them — most
  //    likely a wrong/stale secret. Low confidence: we can't prove which secret the sender used.
  return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
}

/** Per-encoding decode: the strict null-on-malformed decoder, its diagnostic, and any normalization. */
const ENCODING_PARAMS: Readonly<
  Record<
    SignatureEncoding,
    { decode: SignatureDecoder; detail: string; normalize?: (s: string) => string }
  >
> = {
  // Hex is case-insensitive — lowercase before decode so an upper-case provider sig still matches.
  hex: {
    decode: hexToBytes,
    detail: "signature is not valid hex",
    normalize: (s) => s.toLowerCase(),
  },
  base64: { decode: b64ToBytes, detail: "signature is not valid base64" },
  base64url: { decode: b64urlToBytes, detail: "signature is not valid base64url" },
};

export interface HmacVerifyGeneralParams {
  readonly scheme: WebhookScheme;
  readonly rawBody: Uint8Array;
  /** One or more signatures from the header (single-sig schemes pass a one-element array). */
  readonly signatures: readonly string[];
  /** How those signatures are encoded (hex / base64 / base64url). */
  readonly encoding: SignatureEncoding;
  /** The HMAC digest (sha256 / sha1 / sha512). */
  readonly digest: HmacDigest;
  readonly candidates: readonly SecretCandidate[];
  readonly buildMessage: MessageBuilder;
}

/**
 * The general HMAC verify entry: pick the decoder for `encoding` and the hash/MAC-length for `digest`,
 * then run the single audited engine. Every provider goes through here (via the factory). The `*Hex` /
 * `*Base64` helpers below are thin SHA-256 specializations kept for their direct unit tests.
 */
export function verifyHmac(params: HmacVerifyGeneralParams): Promise<VerificationResult> {
  const enc = ENCODING_PARAMS[params.encoding];
  const expectedSigs = enc.normalize ? params.signatures.map(enc.normalize) : params.signatures;
  return verifyHmacCore({
    scheme: params.scheme,
    rawBody: params.rawBody,
    expectedSigs,
    decode: enc.decode,
    malformedDetail: enc.detail,
    digest: params.digest,
    candidates: params.candidates,
    buildMessage: params.buildMessage,
  });
}

export interface HmacVerifyParams {
  readonly scheme: WebhookScheme;
  readonly rawBody: Uint8Array;
  /** One or more hex signatures from the header (single-sig schemes pass a one-element array). */
  readonly expectedHexes: readonly string[];
  readonly candidates: readonly SecretCandidate[];
  readonly buildMessage: MessageBuilder;
}

/** HMAC-SHA256 verification where the expected signatures are hex (Stripe/GitHub/Slack). */
export function verifyHmacHex(params: HmacVerifyParams): Promise<VerificationResult> {
  return verifyHmac({
    scheme: params.scheme,
    rawBody: params.rawBody,
    signatures: params.expectedHexes,
    encoding: "hex",
    digest: "sha256",
    candidates: params.candidates,
    buildMessage: params.buildMessage,
  });
}

export interface HmacVerifyBase64Params {
  readonly scheme: WebhookScheme;
  readonly rawBody: Uint8Array;
  /** One or more base64 signatures from the header (single-sig schemes pass a one-element array). */
  readonly expectedBase64s: readonly string[];
  readonly candidates: readonly SecretCandidate[];
  readonly buildMessage: MessageBuilder;
}

/** HMAC-SHA256 verification where the expected signatures are base64 (Shopify/Standard Webhooks). */
export function verifyHmacBase64(params: HmacVerifyBase64Params): Promise<VerificationResult> {
  return verifyHmac({
    scheme: params.scheme,
    rawBody: params.rawBody,
    signatures: params.expectedBase64s,
    encoding: "base64",
    digest: "sha256",
    candidates: params.candidates,
    buildMessage: params.buildMessage,
  });
}

/** Re-export for adapters that build hex MACs directly (e.g. test/debug seams). */
export { bytesToHex };
