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

/** Compute HMAC-SHA256(key, message) and return the raw MAC bytes. */
export async function hmacSha256(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(mac);
}
