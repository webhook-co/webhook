import { Buffer } from "node:buffer";

// PKCE (RFC 7636, S256) + a CSRF `state` for the OAuth authorization-code flow. The verifier is a
// high-entropy random string; the challenge is base64url(SHA-256(verifier)). The issuer is S256-only
// (plain PKCE is rejected), so we never offer the `plain` method. Uses the global WebCrypto (available
// under Node + Bun), like the rest of the CLI's `crypto.*` usage.

/** base64url (no padding) of raw bytes — the encoding RFC 7636 mandates for the verifier + challenge. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A URL-safe random token of `byteLen` random bytes, base64url-encoded (no padding). */
export function randomBase64url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The S256 code challenge for a verifier: base64url(SHA-256(verifier)). Pure given the verifier. */
export async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** A fresh PKCE pair: a 32-byte (43-char base64url, within RFC 7636's 43–128) verifier + its S256 challenge. */
export async function generatePkce(): Promise<Pkce> {
  const verifier = randomBase64url(32);
  return { verifier, challenge: await deriveChallenge(verifier) };
}

/** A fresh CSRF `state` value for the authorization request. */
export function randomState(): string {
  return randomBase64url(32);
}
