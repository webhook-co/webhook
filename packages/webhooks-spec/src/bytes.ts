// Byte/crypto primitives for the verify adapters. The security-critical ones
// (timingSafeEqual, importHmacKey, bytesToHex, concatBytes) MIRROR the audited
// implementations in `packages/shared/src/bytes.ts` byte-for-byte. They are duplicated
// here on purpose: webhooks-spec is the leaf of the dependency graph (`packages/shared`
// depends on it, not the reverse), so it cannot import from `shared` without creating a
// package cycle that deadlocks the Turborepo `^build` graph. The two files are supersets
// of a shared core, not identical files (each adds its own helpers). A divergence in the
// mirrored functions is caught by bytes-parity.test.ts; if you change one, change both.
//
// Cross-runtime: uses only Web primitives (globalThis.crypto, TextEncoder) available
// in both Cloudflare Workers and Node.

export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode a hex string to bytes. Returns null on odd length or any non-hex character.
 * Strict on the alphabet (Number.parseInt is lenient — parseInt("1z",16) === 1 — so the
 * regex guard is what makes a structurally-malformed signature decode to null, hence a
 * MALFORMED_SIGNATURE diagnostic rather than a misleading mismatch).
 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a standard-alphabet base64 string (`+/`, optional `=` padding) to bytes. Returns
 * null on invalid input — NEVER throws — so a malformed provider signature becomes a typed
 * MALFORMED_SIGNATURE diagnostic, never an exception into the capture path. This is the
 * base64 sibling of {@link hexToBytes} (verification-only; it intentionally does NOT mirror
 * `packages/shared`'s throwing `b64ToBytes`, which is for trusted wire formats).
 */
export function b64ToBytes(b64: string): Uint8Array | null {
  // Reject anything outside the canonical alphabet up front. `atob` implements WHATWG
  // "forgiving base64" — it strips embedded ASCII whitespace and tolerates mangled padding —
  // so without this guard an in-transit-corrupted (e.g. line-folded) signature would decode
  // "successfully" and be reported as a mismatch instead of MALFORMED_SIGNATURE.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encode bytes to standard (padded, `+/` alphabet) base64. The ENCODE sibling of {@link b64ToBytes}:
 * verification only ever DECODES, but the send-side signer ({@link ./sign}) base64-encodes the MAC for
 * the `webhook-signature` header. Byte-identical to packages/shared's `bytesToB64`, pinned by
 * bytes-parity.test.ts (bytesToB64 is in its MIRRORED set) so the two copies cannot drift.
 */
export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Decode a base64url string (`-`/`_` alphabet, optional `=` padding) to bytes. Returns null on
 * invalid input — NEVER throws — the base64url sibling of {@link b64ToBytes} (same null-on-malformed
 * contract, NOT packages/shared's throwing decoder). Some providers carry their MAC as base64url
 * (e.g. Sanity). Translates `-`→`+`, `_`→`/`, re-pads to a multiple of 4, then reuses the strict
 * standard-base64 decode — so the alphabet/length guards live in exactly one place.
 */
export function b64urlToBytes(b64url: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(b64url)) return null;
  let s = b64url.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const rem = s.length % 4;
  if (rem === 1) return null; // a length ≡ 1 mod 4 can never be valid base64
  if (rem !== 0) s += "=".repeat(4 - rem);
  return b64ToBytes(s);
}

/** Length-independent comparison so MAC/hash checks can't be timed. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Import raw key bytes as a non-extractable HMAC-SHA256 CryptoKey. Cache and reuse the
 * returned handle — don't re-import per request, and don't retain the raw bytes.
 */
export function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** The SubtleCrypto digests the verify engine supports (most providers use SHA-256). */
export type HmacHash = "SHA-1" | "SHA-256" | "SHA-512";

/**
 * Import raw key bytes as a non-extractable HMAC CryptoKey for a chosen digest — the
 * digest-parameterized sibling of {@link importHmacKey}, for the providers that sign with SHA-1 or
 * SHA-512 rather than SHA-256. Kept SEPARATE (not a generalization of importHmacKey) so importHmacKey
 * stays byte-for-byte identical to packages/shared's mirror (enforced by bytes-parity.test.ts).
 */
export function importHmacKeyForHash(raw: Uint8Array, hash: HmacHash): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash }, false, ["sign", "verify"]);
}

/** Compute HMAC-SHA256(key, message) and return the raw MAC bytes. */
export async function hmacSha256(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(mac);
}

/** Compute the SHA-256 digest of `data` and return the raw 32 hash bytes (e.g. Twilio's bodySHA256). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Precomputed IEEE 802.3 CRC-32 table (polynomial 0xEDB88320). */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * IEEE CRC-32 of `data` as an UNSIGNED 32-bit integer. PayPal's webhook signature signs
 * `…|crc32(rawBody)` where the CRC is rendered as an unsigned decimal string — `String(crc32(body))`.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
