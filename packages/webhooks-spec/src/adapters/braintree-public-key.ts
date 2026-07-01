// Braintree webhook-subscription handshake (`?bt_challenge=`, S8). Braintree activates a webhook by a GET
// `?bt_challenge=<hex>` and expects the body `<public_key>|<hexHMAC-SHA1(SHA1(private_key), bt_challenge)>`.
// The HMAC key is the SAME SHA1(private_key) that verifies the POST `bt_signature` — so the private key is
// already a `braintree` provider secret. The response ALSO needs the integration PUBLIC key, which POST
// verification never uses. We seal it as a TYPED blob under the same `braintree` slug, distinguishable at
// unseal from the bare private-key signing secret (mirrors the Meta/eBay verify-token blob). The db
// SERIALIZES it on add; the engine's GET handshake PARSES it (and the POST verify SKIPS it). Single-sourced
// here so both sides agree on the exact shape.

import type { Provider } from "./config";

/** The providers whose GET handshake needs a separately-stored integration public key. */
export const BRAINTREE_PUBLIC_KEY_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>([
  "braintree",
]);

/**
 * The exact `bt_challenge` shape the GET handshake will HMAC (a short lowercase-hex nonce). SINGLE-SOURCED
 * so the handshake's oracle domain and the verify-side rejection domain CANNOT drift: the handshake HMACs a
 * challenge matching this pattern under `SHA1(private_key)` — the SAME key that verifies `bt_payload` — so
 * the verify path (via `HmacProviderConfig.rejectSignedMessageMatching`) must reject any `bt_payload` in this
 * SAME domain, else a handshake response `pubkey|HMAC(nonce)` replays as a valid `bt_signature` over
 * `bt_payload=nonce`. Real bt_payloads are long base64 XML — never a ≤40-char hex string — so this domain
 * separation never rejects a genuine event. Exported as a shared RegExp — `.test()` on a flagless pattern is
 * stateless, so both call sites reuse this one instance safely (and neither builds a RegExp from a variable).
 */
export const BRAINTREE_CHALLENGE_PATTERN = /^[a-f0-9]{20,40}$/;

const BRAINTREE_PUBLIC_KEY_KIND = "braintree_public_key";

/** Seal-shape: wrap a raw integration public key into the typed blob the engine recognizes at unseal. */
export function serializeBraintreePublicKey(publicKey: string): string {
  return JSON.stringify({ kind: BRAINTREE_PUBLIC_KEY_KIND, publicKey });
}

/**
 * The inverse of {@link serializeBraintreePublicKey}: the unsealed public key if `plaintext` is a
 * braintree-public-key blob, else `null`. A bare private-key signing secret is NOT JSON of this shape →
 * `null`, so the POST verify uses it (and the handshake skips it); malformed JSON, a wrong/absent kind, or a
 * non-string/empty publicKey are all `null`.
 */
export function parseBraintreePublicKey(plaintext: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const blob = parsed as { kind?: unknown; publicKey?: unknown };
  if (blob.kind !== BRAINTREE_PUBLIC_KEY_KIND) return null;
  if (typeof blob.publicKey !== "string" || blob.publicKey.length === 0) return null;
  return blob.publicKey;
}
