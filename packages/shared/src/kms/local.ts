// Local/dev KEK custodian for the KMS seam (§0.6, WS-B1).
//
// This is the dev/CI-default `KmsProvider`: a process-local AES-256-GCM key-encryption key
// (KEK) that wraps/unwraps DEKs entirely in WebCrypto, no live infra. It sits behind the exact
// same `KmsProvider` interface the AWS KMS custodian (WS-B2) will implement later, so callers
// never branch on which custodian is in play — only the construction site changes.
//
// Wrapping uses `crypto.subtle.wrapKey`/`unwrapKey` so the plaintext DEK bytes never transit
// JS: a freshly generated (transiently extractable) DEK is wrapped under the KEK, then the
// usable handle handed back is re-derived as NON-EXTRACTABLE (M7). `unwrapKey` likewise yields
// a non-extractable AES-GCM handle. The KEK's encryption context (AAD) binds the wrap to
// {org_id, endpoint_id, key_id}, so a DEK wrapped for one context cannot be unwrapped under
// another (confused-deputy protection), mirroring the secret-layer AAD in `envelope.ts`.

import { concatBytes } from "../bytes";
import {
  DEK_BYTES,
  GCM_NONCE_BYTES,
  encryptionContextAad,
  type EncryptionContext,
  type KmsProvider,
  type WrappedDek,
} from "../envelope";

const DEFAULT_KEK_REF = "local-dev-kek";

/** AES-256 raw KEK length in bytes. */
const KEK_BYTES = 32;

// The KEK-wrap AAD version is FROZEN, deliberately decoupled from ENVELOPE_VERSION.
// ENVELOPE_VERSION tracks the SECRET payload format (sealSecret/openSecret), which is
// allowed to migrate; the local KEK merely wraps a random DEK and only needs an AAD it can
// reconstruct at unwrap time. Coupling this to ENVELOPE_VERSION would mean a secret-format
// bump silently changed the wrap AAD and made every previously-wrapped DEK un-unwrappable.
// Wrap and unwrap MUST use the same value — keep them pinned to this one constant.
const KEK_WRAP_AAD_VERSION = 1;

export class LocalKmsProvider implements KmsProvider {
  readonly #kek: CryptoKey;
  readonly #kekRef: string;

  private constructor(kek: CryptoKey, kekRef: string) {
    this.#kek = kek;
    this.#kekRef = kekRef;
  }

  /** The local key id stamped onto every `WrappedDek` this provider produces. */
  get kekRef(): string {
    return this.#kekRef;
  }

  /** Generate a fresh, extractable-for-export local KEK. Use only for dev/CI. */
  static async generate(kekRef: string = DEFAULT_KEK_REF): Promise<LocalKmsProvider> {
    // Extractable so a dev/CI harness can persist the raw KEK across instances (see
    // `exportRawKek`). The wrapped DEKs and the secret ciphertext are what actually live in
    // a row; this raw KEK is the dev stand-in for what AWS KMS will custody.
    const kek = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "wrapKey",
      "unwrapKey",
    ])) as CryptoKey;
    return new LocalKmsProvider(kek, kekRef);
  }

  /** Rebuild a provider from previously exported raw KEK bytes (dev/CI persistence only). */
  static async fromRawKek(
    raw: Uint8Array,
    kekRef: string = DEFAULT_KEK_REF,
  ): Promise<LocalKmsProvider> {
    if (raw.length !== KEK_BYTES) {
      throw new Error(`local KEK must be ${KEK_BYTES} bytes, got ${raw.length}`);
    }
    const kek = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
      "wrapKey",
      "unwrapKey",
    ]);
    return new LocalKmsProvider(kek, kekRef);
  }

  /** Export the raw KEK bytes. Dev/CI persistence only — never call this in production code. */
  async exportRawKek(): Promise<Uint8Array> {
    // exportKey("raw", ...) always returns an ArrayBuffer; the union with JsonWebKey is only
    // for the "jwk" format. Narrow explicitly.
    return new Uint8Array((await crypto.subtle.exportKey("raw", this.#kek)) as ArrayBuffer);
  }

  async generateDek(context: EncryptionContext): Promise<{ dek: CryptoKey; wrapped: WrappedDek }> {
    // Generate the DEK transiently extractable so it can be wrapped under the KEK, then wrap
    // it. The handle we return to the caller is re-imported as non-extractable (M7) — the
    // extractable copy is never returned and goes out of scope immediately after wrapping.
    const extractableDek = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKey;

    const wrapped = await this.#wrap(extractableDek, context);
    const rawDek = new Uint8Array(
      (await crypto.subtle.exportKey("raw", extractableDek)) as ArrayBuffer,
    );
    const dek = await importNonExtractableDek(rawDek);

    return { dek, wrapped };
  }

  async unwrapDek(wrapped: WrappedDek, context: EncryptionContext): Promise<CryptoKey> {
    if (wrapped.kekRef !== this.#kekRef) {
      throw new Error(
        `local KEK ref mismatch: wrapped under "${wrapped.kekRef}", this provider is "${this.#kekRef}"`,
      );
    }
    if (wrapped.wrappedDek.length <= GCM_NONCE_BYTES) {
      throw new Error("wrapped DEK is too short to contain a nonce + ciphertext");
    }
    const nonce = wrapped.wrappedDek.subarray(0, GCM_NONCE_BYTES);
    const body = wrapped.wrappedDek.subarray(GCM_NONCE_BYTES);

    // `unwrapKey` verifies the GCM tag against the AAD; a context or kekRef mismatch, or any
    // tamper, throws here. The result is a NON-EXTRACTABLE AES-GCM handle (M7).
    return crypto.subtle.unwrapKey(
      "raw",
      body,
      this.#kek,
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encryptionContextAad(context, KEK_WRAP_AAD_VERSION),
      },
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async #wrap(dek: CryptoKey, context: EncryptionContext): Promise<WrappedDek> {
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    const body = await crypto.subtle.wrapKey("raw", dek, this.#kek, {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encryptionContextAad(context, KEK_WRAP_AAD_VERSION),
    });
    return {
      wrappedDek: concatBytes(nonce, new Uint8Array(body)),
      kekRef: this.#kekRef,
    };
  }
}

/** Import raw DEK bytes as a non-extractable AES-GCM handle (M7), validating the length. */
async function importNonExtractableDek(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
