// A0a — asymmetric (public-key) signature verification primitives, for the Tier-3 providers that sign with
// a private key and hand the receiver a PUBLIC key (the registered "secret" is that public key, not a
// shared HMAC secret). Built on workerd's WebCrypto. Every function is fail-closed and NEVER throws: a
// wrong-length input or any importKey/verify rejection returns false, so a malformed key/signature is a
// rejection, never an exception into the durable-before-ACK capture path.
//
// Algorithm notes (Cloudflare Workers WebCrypto):
//   - Ed25519: importKey("raw", 32-byte key, { name: "Ed25519" }) + verify("Ed25519", …) — the standard
//     Secure-Curves name (the older "NODE-ED25519" is legacy). Ed25519 hashes internally (no `hash` param).
//   - ECDSA P-256 / RSASSA-PKCS1-v1_5 land alongside their providers (SendGrid / Wise).

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
