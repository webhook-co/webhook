// Opaque-credential primitives shared by EVERY bearer-ish credential in the system
// (api keys today; ingest tokens in phase 1). One mint/hash discipline, one resolver
// pattern — so the two credential families can never drift into two implementations.
//
// Discipline (ADR-0003 / ADR-0008 Option B): a credential is a CSPRNG >=256-bit secret,
// shown once at creation and NEVER stored. Only its sha256 hash is persisted, and all
// lookups go by that hash. sha256 is intentional and correct here (S4): the secret is
// full-entropy random, so a slow/keyed hash (argon2/bcrypt) would defend nothing — those
// exist to slow offline brute force of LOW-entropy human passwords. There is no password
// to brute force. Do NOT "upgrade" this to a slow hash.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of CSPRNG entropy in a minted secret. 32 bytes = 256 bits (ADR-0003 floor). */
export const CREDENTIAL_SECRET_BYTES = 32;

/** Characters of the plaintext kept as the non-secret display `start` (prefix + a few). */
const START_LEN = 11;

export interface MintedCredential {
  /** The full plaintext, shown to the caller exactly once and never persisted. */
  readonly plaintext: string;
  /** sha256(plaintext) — the ONLY representation that touches storage. */
  readonly keyHash: Buffer;
  /** A short, non-secret display handle (prefix + a few leading chars) for lists. */
  readonly start: string;
}

/**
 * Mint a new opaque credential: `<prefix>_<base64url(32 random bytes)>`. Returns the
 * plaintext (return to the user once), its sha256 hash (persist this), and a truncated
 * non-secret `start` for display. The plaintext is never written anywhere by this code.
 */
export function mintCredential(prefix: string): MintedCredential {
  const secret = randomBytes(CREDENTIAL_SECRET_BYTES);
  const plaintext = `${prefix}_${secret.toString("base64url")}`;
  return {
    plaintext,
    keyHash: hashCredential(plaintext),
    start: plaintext.slice(0, START_LEN),
  };
}

/** sha256 of a plaintext credential, as raw bytes (matches the `bytea` column). */
export function hashCredential(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext).digest();
}

/**
 * Constant-time hash compare. Defense-in-depth: a by-hash DB lookup already matches on
 * equality, but verification must never branch on a timing-leaky compare. Lengths are
 * compared first (timingSafeEqual throws on a length mismatch) and that branch leaks
 * nothing secret — both are fixed-width sha256 digests.
 */
export function credentialHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A credential's display key for a cache (hex of the hash — never the plaintext). */
export function credentialCacheKey(keyHash: Buffer): string {
  return keyHash.toString("hex");
}
