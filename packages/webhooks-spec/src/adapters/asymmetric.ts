// A0a — asymmetric (public-key) signature verification primitives, for the Tier-3 providers that sign with
// a private key and hand the receiver a PUBLIC key (the registered "secret" is that public key, not a
// shared HMAC secret). Built on workerd's WebCrypto. Every function is fail-closed and NEVER throws: a
// wrong-length input or any importKey/verify rejection returns false, so a malformed key/signature is a
// rejection, never an exception into the durable-before-ACK capture path.
//
// Algorithm notes (Cloudflare Workers WebCrypto):
//   - Ed25519: importKey("raw", 32-byte key, { name: "Ed25519" }) + verify("Ed25519", …) — the standard
//     Secure-Curves name (the older "NODE-ED25519" is legacy). Ed25519 hashes internally (no `hash` param).
//   - ECDSA P-256 (SendGrid): importKey("spki", DER) + verify({name:"ECDSA",hash:"SHA-256"}) — WebCrypto
//     wants the signature as IEEE-P1363 raw r||s (64 bytes), NOT DER, so SendGrid's DER sig is converted.
//   - RSASSA-PKCS1-v1_5 SHA-256 (Wise): importKey("spki", DER) + verify("RSASSA-PKCS1-v1_5").

import { b64ToBytes } from "../bytes";

/**
 * Verify an Ed25519 (RFC 8032) signature. All inputs are raw bytes: a 32-byte public key, the exact signed
 * message, and a 64-byte signature. Returns false on any wrong-length input or crypto error (never throws).
 */
export async function verifyEd25519(
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKeyRaw, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    return false;
  }
}

/**
 * Verify an RSASSA-PKCS1-v1_5 + SHA-256 signature. `spkiDer` is the public key as SubjectPublicKeyInfo DER
 * bytes; `signature` is the raw signature bytes (RSA signatures carry no encoding wrapper). Returns false on
 * any error (bad key/sig) — never throws.
 */
export async function verifyRsaPkcs1Sha256(
  spkiDer: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spkiDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, message);
  } catch {
    return false;
  }
}

/**
 * Verify an RSASSA-PKCS1-v1_5 + SHA-256 signature with an RSA public key in JWK form (`{kty:"RSA", n, e}`,
 * as a JWKS exposes — Kinde). Returns false on any error — never throws.
 */
export async function verifyRsaPkcs1Sha256Jwk(
  jwk: JsonWebKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, message);
  } catch {
    return false;
  }
}

/**
 * Verify an ECDSA P-256 + SHA-256 signature. `spkiDer` is the SubjectPublicKeyInfo DER public key;
 * `signatureRaw` MUST be the IEEE-P1363 raw `r||s` (64 bytes for P-256), NOT DER — convert a DER signature
 * with {@link derEcdsaSigToRaw} first. Returns false on any error / wrong length — never throws.
 */
export async function verifyEcdsaP256Sha256(
  spkiDer: Uint8Array,
  message: Uint8Array,
  signatureRaw: Uint8Array,
): Promise<boolean> {
  if (signatureRaw.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spkiDer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureRaw,
      message,
    );
  } catch {
    return false;
  }
}

/**
 * Convert a DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`, as OpenSSL/SendGrid emit) to the
 * IEEE-P1363 raw `r||s` form WebCrypto's verify() wants, with `coordSize` bytes per coordinate (32 for
 * P-256). A minimal, bounds-checked DER walk — returns null on ANY malformation (never throws), so a junk
 * signature becomes a typed MALFORMED at the call site. Strips each INTEGER's sign byte and left-pads to
 * `coordSize`; a coordinate longer than `coordSize` (after stripping leading zeros) is rejected.
 */
export function derEcdsaSigToRaw(der: Uint8Array, coordSize = 32): Uint8Array | null {
  let pos = 0;
  const next = (): number | null => {
    const b = der[pos];
    if (b === undefined) return null;
    pos++;
    return b;
  };
  if (next() !== 0x30) return null; // SEQUENCE tag
  const seqLen = next(); // consume the sequence length (short or long form); value itself unused
  if (seqLen === null) return null;
  if (seqLen & 0x80) {
    for (let k = 0; k < (seqLen & 0x7f); k++) if (next() === null) return null;
  }
  const readInt = (): Uint8Array | null => {
    if (next() !== 0x02) return null; // INTEGER tag
    const len = next();
    if (len === null || len === 0 || len & 0x80) return null; // non-empty, short-form
    const start = pos;
    pos += len;
    if (pos > der.length) return null;
    return der.subarray(start, pos);
  };
  const r = readInt();
  const s = readInt();
  if (r === null || s === null) return null;

  const out = new Uint8Array(coordSize * 2);
  const place = (value: Uint8Array, offset: number): boolean => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start++; // strip leading sign/zero bytes
    const trimmed = value.subarray(start);
    if (trimmed.length > coordSize) return false;
    out.set(trimmed, offset + (coordSize - trimmed.length));
    return true;
  };
  if (!place(r, 0) || !place(s, coordSize)) return null;
  return out;
}

/**
 * Parse a PEM "PUBLIC KEY" (or similar) block to its DER bytes for importKey("spki", …). Returns null if the
 * input has no well-formed PEM block or the base64 is invalid — never throws.
 */
export function pemToDer(pem: string): Uint8Array | null {
  const match = pem.match(/-----BEGIN [A-Z0-9 ]+-----([A-Za-z0-9+/=\s]+)-----END [A-Z0-9 ]+-----/);
  const body = match?.[1];
  if (body === undefined) return null;
  return b64ToBytes(body.replace(/\s+/g, ""));
}
