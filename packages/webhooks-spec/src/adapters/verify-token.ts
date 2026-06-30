// GET-handshake verify-token secret shape (S8 Slice 2 PR2b, ADR-0086). Some providers gate a webhook
// subscription on a one-time GET handshake that echoes a challenge IFF a user-chosen verify-token matches
// (Meta `hub.verify_token`; eBay's verification token). That verify-token is a SECOND secret on a provider
// that ALSO has a payload-signing secret under the same slug (Meta's app secret keys the POST signature) —
// so the slug alone can't disambiguate the two. We seal the verify-token as a TYPED blob so it is
// distinguishable, at unseal, from a bare signing secret. The db SERIALIZES on add; the engine PARSES on
// the handshake. Single-sourced here so both sides agree on the exact shape.

import { timingSafeEqual, utf8Encoder } from "../bytes";
import type { Provider } from "./config";

/** The providers whose subscription verification compares a user-chosen verify-token in a GET handshake. */
export const VERIFY_TOKEN_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(["meta"]);

const VERIFY_TOKEN_KIND = "verify_token";

/** Seal-shape: wrap a raw verify-token into the typed blob the engine recognizes at unseal. */
export function serializeVerifyTokenSecret(token: string): string {
  return JSON.stringify({ kind: VERIFY_TOKEN_KIND, token });
}

/**
 * The inverse of {@link serializeVerifyTokenSecret}: the unsealed token if `plaintext` is a verify-token
 * blob, else `null`. A bare signing secret (Meta's app secret) is NOT JSON of this shape → `null`, so the
 * handshake skips it; malformed JSON, a wrong/absent kind, or a non-string/empty token are all `null`.
 */
export function parseVerifyTokenSecret(plaintext: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const blob = parsed as { kind?: unknown; token?: unknown };
  if (blob.kind !== VERIFY_TOKEN_KIND) return null;
  if (typeof blob.token !== "string" || blob.token.length === 0) return null;
  return blob.token;
}

/** Constant-time byte-exact equality of a presented verify-token against the stored one. */
export function verifyTokenEqual(presented: string, stored: string): boolean {
  return timingSafeEqual(utf8Encoder.encode(presented), utf8Encoder.encode(stored));
}
