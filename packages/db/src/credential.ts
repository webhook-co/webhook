// Opaque-credential primitives shared by EVERY bearer-ish credential in the system
// (api keys today; ingest tokens on the ingest path). One mint/hash discipline, one resolver
// pattern — so the two credential families can never drift into two implementations.
//
// Discipline (ADR-0003 / ADR-0008 Option B): a credential is a CSPRNG >=256-bit secret,
// shown once at creation and NEVER stored. Only a hash of it is persisted, and all
// lookups go by that hash.
//
// WHY HMAC-SHA256 WITH A PEPPER — not a slow KDF, and not a bare sha256:
//   * NOT a slow KDF (argon2/bcrypt/scrypt): slow KDFs exist to throttle brute force of
//     LOW-entropy HUMAN passwords. This secret is full-entropy 256-bit random — there is
//     nothing to brute force, so a slow hash would add latency (~50-100ms/verify) for
//     ZERO security gain, and is the wrong tool. Do NOT "upgrade" this to argon2/bcrypt.
//     (This is also why CodeQL's password-oriented js/insufficient-password-hash does not
//     apply here — it cannot tell a 256-bit random token from a guessable password.)
//   * NOT a bare sha256: we KEY the hash with a server-side PEPPER held OUTSIDE the
//     database — a Worker/wrangler secret or KMS binding, never a DB column, same custody
//     as the ADR-0004 audit-chain key. HMAC-SHA256 is as fast as sha256 (no latency cost),
//     but it buys defense-in-depth against a DATABASE-ONLY breach: an attacker who
//     exfiltrates key_hash values (e.g. via the documented webhook_authn column-grant
//     residual) cannot confirm or match even a KNOWN plaintext without ALSO stealing the
//     pepper. Worst case (pepper AND db both leak) degrades to bare-sha256 security, which
//     is still safe for a 256-bit secret — so peppering is strictly additive.
//   * Rotation: `previous` peppers keep live keys valid across a pepper rotation — mint
//     and the canonical stored hash use `current`; verification tries current then any
//     previous. Existing keys can't be re-hashed (we never keep the plaintext), so a
//     rotation window accepts both until old keys are revoked/expired.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of CSPRNG entropy in a minted secret. 32 bytes = 256 bits (ADR-0003 floor). */
export const CREDENTIAL_SECRET_BYTES = 32;

/** Minimum pepper length: 256 bits, so the keyed hash is no weaker than the secret. */
export const CREDENTIAL_PEPPER_MIN_BYTES = 32;

/** Characters of the plaintext kept as the non-secret display `start` (prefix + a few). */
const START_LEN = 11;

export interface MintedCredential {
  /** The full plaintext, shown to the caller exactly once and never persisted. */
  readonly plaintext: string;
  /** HMAC-SHA256(current pepper, plaintext) — the ONLY representation that touches storage. */
  readonly keyHash: Buffer;
  /** A short, non-secret display handle (prefix + a few leading chars) for lists. */
  readonly start: string;
}

/**
 * Keyed hasher for opaque credentials. `hash` is HMAC-SHA256(current pepper, plaintext) —
 * the canonical representation that touches storage and the cache. `candidates` returns
 * the [current, ...previous] hashes so verification stays valid across a pepper rotation.
 */
export interface CredentialHasher {
  hash(plaintext: string): Buffer;
  candidates(plaintext: string): Buffer[];
}

export interface CredentialPeppers {
  /** The active pepper — used to mint and to store the canonical hash. */
  readonly current: Buffer;
  /** Older peppers still accepted on verify during a rotation window. */
  readonly previous?: readonly Buffer[];
}

/** Build a CredentialHasher over a current pepper (+ optional previous peppers). */
export function createCredentialHasher(peppers: CredentialPeppers): CredentialHasher {
  assertPepperLength(peppers.current);
  const previous = peppers.previous ?? [];
  previous.forEach(assertPepperLength);
  const all = [peppers.current, ...previous];
  const mac = (pepper: Buffer, plaintext: string): Buffer =>
    createHmac("sha256", pepper).update(plaintext, "utf8").digest();
  return {
    hash: (plaintext) => mac(peppers.current, plaintext),
    candidates: (plaintext) => all.map((p) => mac(p, plaintext)),
  };
}

function assertPepperLength(pepper: Buffer): void {
  if (pepper.length < CREDENTIAL_PEPPER_MIN_BYTES) {
    throw new Error(
      `credential pepper must be >= ${CREDENTIAL_PEPPER_MIN_BYTES} bytes (256 bits); ` +
        `got ${pepper.length}`,
    );
  }
}

/**
 * Mint a new opaque credential: `<prefix>_<base64url(32 random bytes)>`. Returns the
 * plaintext (return to the user once), its keyed hash (persist this), and a truncated
 * non-secret `start` for display. The plaintext is never written anywhere by this code.
 */
export function mintCredential(prefix: string, hasher: CredentialHasher): MintedCredential {
  const secret = randomBytes(CREDENTIAL_SECRET_BYTES);
  const plaintext = `${prefix}_${secret.toString("base64url")}`;
  return {
    plaintext,
    keyHash: hasher.hash(plaintext),
    start: plaintext.slice(0, START_LEN),
  };
}

/**
 * Constant-time hash compare. Defense-in-depth: a by-hash DB lookup already matches on
 * equality, but verification must never branch on a timing-leaky compare. Lengths are
 * compared first (timingSafeEqual throws on a length mismatch) and that branch leaks
 * nothing secret — both are fixed-width HMAC-SHA256 digests.
 */
export function credentialHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A credential's display key for a cache (hex of the hash — never the plaintext). */
export function credentialCacheKey(keyHash: Buffer): string {
  return keyHash.toString("hex");
}
