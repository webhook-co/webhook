// Secret-store helper: the thin Phase-1 seam over the envelope + KMS primitives (§0.6).
//
// Callers (signing-key custody, inbound provider secrets) want two operations, not five:
//   - seal(plaintext, ctx)  -> a self-contained record to persist
//   - open(record, ctx)     -> the plaintext back
//
// On write we ask the `KmsProvider` for a fresh DEK + its wrapped form, seal the secret under
// the DEK (AAD-bound to ctx), and return the ciphertext + wrapped DEK + envelope version — the
// exact set a row stores. On read we unwrap the DEK (optionally via the org-scoped LRU, which
// caches the non-extractable handle per ADR-0007) and open the secret. The KMS custodian is
// injected, so the same helper works over the local dev KEK today and AWS KMS (WS-B2) later
// with no caller changes.

import { bytesToB64url, utf8Decoder, utf8Encoder } from "./bytes";
import {
  ENVELOPE_VERSION,
  openSecret,
  sealSecret,
  type EncryptionContext,
  type KmsProvider,
  type WrappedDek,
} from "./envelope";
import type { OrgScopedDekCache } from "./kms/lru";

/** A self-contained sealed record: everything a row needs to round-trip one secret. */
export interface SealedRecord {
  /** AES-256-GCM ciphertext with the 16-byte tag appended. */
  readonly ciphertext: Uint8Array;
  /** 96-bit GCM nonce for the secret layer. */
  readonly nonce: Uint8Array;
  /** The DEK wrapped by the KEK, plus the KEK reference. */
  readonly wrapped: WrappedDek;
  /** Envelope format version, threaded so a future reader can reconstruct the AAD. */
  readonly envelopeVersion: number;
}

export class SecretStore {
  readonly #kms: KmsProvider;
  readonly #cache?: OrgScopedDekCache;

  /**
   * @param kms   the KEK custodian (local dev KEK today, AWS KMS later — same seam).
   * @param cache optional org-scoped LRU for unwrapped DEK handles. Omit to unwrap per read;
   *              provide one to cache hot DEKs (BAA orgs are bypassed inside the cache).
   */
  constructor(kms: KmsProvider, cache?: OrgScopedDekCache) {
    this.#kms = kms;
    this.#cache = cache;
  }

  /** Seal a secret on write: fresh DEK -> seal under it -> return the persistable record. */
  async seal(plaintext: Uint8Array, context: EncryptionContext): Promise<SealedRecord> {
    const { dek, wrapped } = await this.#kms.generateDek(context);
    const sealed = await sealSecret(dek, plaintext, context);
    return {
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      wrapped,
      envelopeVersion: ENVELOPE_VERSION,
    };
  }

  /** Open a sealed record on read: unwrap the DEK (cached if configured) -> open the secret. */
  async open(record: SealedRecord, context: EncryptionContext): Promise<Uint8Array> {
    const dek = await this.#unwrap(record.wrapped, context);
    return openSecret(
      dek,
      { ciphertext: record.ciphertext, nonce: record.nonce },
      context,
      record.envelopeVersion,
    );
  }

  /** String convenience over {@link seal} (UTF-8). */
  sealString(plaintext: string, context: EncryptionContext): Promise<SealedRecord> {
    return this.seal(utf8Encoder.encode(plaintext), context);
  }

  /** String convenience over {@link open} (UTF-8). */
  async openString(record: SealedRecord, context: EncryptionContext): Promise<string> {
    return utf8Decoder.decode(await this.open(record, context));
  }

  #unwrap(wrapped: WrappedDek, context: EncryptionContext): Promise<CryptoKey> {
    if (this.#cache === undefined) {
      return this.#kms.unwrapDek(wrapped, context);
    }
    // Cache key is (orgId, kekRef + the FULL wrapped-DEK bytes) — distinct wraps of the same
    // DEK never alias. We use the full bytes (base64url), NOT a short digest: on a cache HIT
    // the loader (unwrapDek) is never called, so a digest collision would hand back another
    // entry's DEK handle with no AAD check to catch it. The full bytes are the identity, so
    // collisions are impossible by construction.
    const wrapRef = `${wrapped.kekRef}:${bytesToB64url(wrapped.wrappedDek)}`;
    return this.#cache.getOrLoad(context.orgId, wrapRef, () =>
      this.#kms.unwrapDek(wrapped, context),
    );
  }
}
