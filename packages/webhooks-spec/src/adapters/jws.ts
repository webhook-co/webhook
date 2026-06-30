// A0b — the compact-JWS (JWT) primitive shared by the HS256 JWT providers (MessageBird-JWT, Netlify,
// Vonage, Monday, Jira Connect). These providers don't HMAC the raw body; they sign a JWT whose claims
// authenticate the request and (for most) bind the body via a `…_hash` claim the adapter recomputes.
//
// This module does ONLY the JOSE mechanics, all fail-closed and never-throwing:
//   - structural parse of a 3-segment compact JWS,
//   - an `alg` allowlist gate that rejects `none` and any asymmetric/unsupported alg (the classic JWS
//     downgrade defense — we NEVER skip signature verification),
//   - constant-time HS256/HS512 verification of the signing input against utf8 secret candidates.
// Per-provider claim binding (payload_hash, url_hash, iss, exp, qsh) lives in each bespoke adapter — this
// stays provider-agnostic. The HMAC step reuses the audited primitives in ../bytes (no new crypto).

import { b64urlToBytes, importHmacKeyForHash, timingSafeEqual, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { verificationFailed, type VerificationResult } from "../verification";

export interface ParsedJws {
  /** The decoded JOSE header object (e.g. `{ alg: "HS256", typ: "JWT" }`). */
  readonly header: Readonly<Record<string, unknown>>;
  /** The decoded claims object. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The EXACT ASCII bytes of `header_b64u.payload_b64u` — the bytes the JWS signature covers. */
  readonly signingInput: Uint8Array;
  /** The base64url-decoded signature/MAC bytes. */
  readonly signature: Uint8Array;
}

/** base64url-decode a segment and JSON.parse it, requiring a (non-array) object. null on any failure. */
function decodeJsonObject(segment: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(segment);
  if (bytes === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse a compact JWS (exactly three base64url segments). Returns null on ANY structural malformation —
 * wrong segment count (a 5-part JWE → null), an undecodable / non-object header or payload, or an
 * empty/undecodable signature — never throws. A null result is a typed MALFORMED at the call site.
 */
export function parseCompactJws(token: string): ParsedJws | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = decodeJsonObject(headerB64);
  const payload = decodeJsonObject(payloadB64);
  if (header === null || payload === null) return null;
  const signature = b64urlToBytes(signatureB64);
  if (signature === null || signature.length === 0) return null;
  return {
    header,
    payload,
    signingInput: utf8Encoder.encode(`${headerB64}.${payloadB64}`),
    signature,
  };
}

/** The outcome of an HS verify: the matched secret index + claims on success, else a typed reason. */
export type JwsVerifyOutcome =
  | {
      readonly ok: true;
      readonly secretIndex: number;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unsupported_alg" | "no_key" | "signature_mismatch";
    };

/**
 * The symmetric HS algs this verifier supports → their SubtleCrypto hash. HS384 is intentionally absent
 * (importHmacKeyForHash has no SHA-384 and no target provider emits it); a token using it is rejected as
 * unsupported rather than silently accepted.
 */
const HS_ALG_TO_HASH: Readonly<Record<string, "SHA-256" | "SHA-512">> = {
  HS256: "SHA-256",
  HS512: "SHA-512",
};

/**
 * Verify a compact HS-signed JWS against utf8 secret candidates (rotation: newest first), constant-time.
 * The secret is used VERBATIM as the UTF-8 key — these providers never base64/hex-decode it. Gate order:
 * malformed (un-parseable) → unsupported_alg (`alg` not in `allowedAlgs`, or `none`/asymmetric) → no_key
 * (no non-empty secret) → signature_mismatch. On success returns the matched index + decoded claims for
 * the caller's per-provider binding. Defaults to HS256-only (pass `allowedAlgs` to widen).
 */
export async function verifyCompactHs(
  token: string,
  secrets: readonly string[],
  allowedAlgs: readonly string[] = ["HS256"],
): Promise<JwsVerifyOutcome> {
  const parsed = parseCompactJws(token);
  if (parsed === null) return { ok: false, reason: "malformed" };

  const alg = parsed.header.alg;
  if (typeof alg !== "string" || !allowedAlgs.includes(alg) || HS_ALG_TO_HASH[alg] === undefined) {
    return { ok: false, reason: "unsupported_alg" };
  }
  const hash = HS_ALG_TO_HASH[alg];

  const candidates: { readonly index: number; readonly bytes: Uint8Array }[] = [];
  secrets.forEach((s, i) => {
    const bytes = utf8Encoder.encode(s);
    if (bytes.length > 0) candidates.push({ index: i, bytes });
  });
  if (candidates.length === 0) return { ok: false, reason: "no_key" };

  for (const c of candidates) {
    const key = await importHmacKeyForHash(c.bytes, hash);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, parsed.signingInput));
    if (timingSafeEqual(mac, parsed.signature)) {
      return { ok: true, secretIndex: c.index, payload: parsed.payload };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** A non-ok verifyCompactHs reason. */
export type JwsFailureReason = Exclude<JwsVerifyOutcome, { readonly ok: true }>["reason"];

/**
 * Map a JOSE-level failure onto a typed VerificationResult for `scheme`, so the five HS256 JWT adapters
 * translate the JWS taxonomy consistently: a wrong key → WRONG_SECRET, no usable key → NO_MATCHING_KEY,
 * and any structural / alg problem → MALFORMED_SIGNATURE (the alg gate's downgrade rejection included).
 */
export function jwsFailureToResult(
  reason: JwsFailureReason,
  scheme: WebhookScheme,
): VerificationResult {
  switch (reason) {
    case "no_key":
      return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    case "signature_mismatch":
      return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
    case "malformed":
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "not a compact JWS",
        scheme,
      });
    case "unsupported_alg":
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "unsupported JWT alg",
        scheme,
      });
  }
}
