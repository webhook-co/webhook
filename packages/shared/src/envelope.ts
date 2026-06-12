import { utf8Encoder } from "./bytes";

// Envelope-encryption format + the KmsProvider seam (§0.6, M6, M7). The freeze fixes
// the FORMAT and the interface; the concrete KMS custodian (AWS KMS day-one) and the
// org-scoped plaintext cache are the post-freeze KMS workstream.
//
// Two tiers: a KEK lives in a real KMS (only ever wraps/unwraps a DEK); a random
// AES-256 DEK encrypts the actual secret locally with AES-256-GCM. The row stores the
// secret ciphertext + the wrapped DEK; KMS never sees the secret or the plaintext DEK
// at rest. enc_context (the AAD) binds {org_id, endpoint_id, key_id} at encrypt time
// for confused-deputy / tamper protection; envelope_version lets the format migrate.

export const ENVELOPE_VERSION = 1 as const;
export const GCM_NONCE_BYTES = 12; // 96-bit nonce (M6)
export const DEK_BYTES = 32; // AES-256
export const GCM_TAG_BYTES = 16;

/** AAD inputs, bound at encrypt time and echoed as the KMS encryption context. */
export interface EncryptionContext {
  readonly orgId: string;
  readonly endpointId: string;
  readonly keyId: string;
}

/** A DEK wrapped by the KEK, plus the KEK reference (the single KMS fork point). */
export interface WrappedDek {
  readonly wrappedDek: Uint8Array;
  readonly kekRef: string;
}

/**
 * The KMS seam. Open core depends on this interface + the envelope format + a single
 * default implementation; /ee adds per-tenant KEK custody and customer-held KMS.
 * unwrapDek MUST return a NON-EXTRACTABLE CryptoKey handle, never raw key bytes (M7),
 * so a cached DEK can't be exfiltrated from a shared isolate's memory.
 */
export interface KmsProvider {
  /** Generate a fresh DEK; return the usable (non-extractable) handle + its wrapped form. */
  generateDek(context: EncryptionContext): Promise<{ dek: CryptoKey; wrapped: WrappedDek }>;
  /** Unwrap a stored wrapped DEK to a non-extractable AES-GCM CryptoKey handle (M7). */
  unwrapDek(wrapped: WrappedDek, context: EncryptionContext): Promise<CryptoKey>;
}

/** Length-prefixed canonical AAD bytes for the encryption context. */
export function encryptionContextAad(ctx: EncryptionContext): Uint8Array {
  const seg = (s: string) => `${utf8Encoder.encode(s).length}:${s}`;
  return utf8Encoder.encode(
    `env${ENVELOPE_VERSION}|${seg(ctx.orgId)}${seg(ctx.endpointId)}${seg(ctx.keyId)}`,
  );
}

/**
 * Import raw DEK bytes as an AES-GCM CryptoKey. Defaults to NON-EXTRACTABLE (M7) —
 * pass extractable only for tooling/KATs, never for cached hot-path keys.
 */
export function importDek(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

export interface SealedSecret {
  /** AES-256-GCM ciphertext with the 16-byte tag appended (WebCrypto layout). */
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
}

/** Encrypt a secret under the DEK, AAD-bound to the encryption context. */
export async function sealSecret(
  dek: CryptoKey,
  plaintext: Uint8Array,
  context: EncryptionContext,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES)),
): Promise<SealedSecret> {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`nonce must be ${GCM_NONCE_BYTES} bytes`);
  }
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encryptionContextAad(context) },
    dek,
    plaintext,
  );
  return { ciphertext: new Uint8Array(ct), nonce };
}

/** Decrypt a secret; throws if the ciphertext, nonce, or AAD context doesn't match. */
export async function openSecret(
  dek: CryptoKey,
  sealed: SealedSecret,
  context: EncryptionContext,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.nonce, additionalData: encryptionContextAad(context) },
    dek,
    sealed.ciphertext,
  );
  return new Uint8Array(pt);
}

/** Convenience: a fresh random DEK as a non-extractable AES-GCM handle. */
export async function generateDekKey(): Promise<CryptoKey> {
  // generateKey returns CryptoKey for a symmetric algorithm (CryptoKeyPair is only for
  // asymmetric); narrow the union explicitly.
  return (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
}
