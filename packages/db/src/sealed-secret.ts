// The on-disk envelope shape shared by the sealed-secret tables (provider_secrets + signing_keys): a
// per-secret AES-256-GCM ciphertext, the KEK-wrapped DEK + its ref, the nonce, and the envelope version.
// Mapping the row columns to a SealedRecord lives HERE, in one place, so the two readers (inbound
// provider-secrets verify path + outbound signing-keys sign path) can never drift on the byte shape the
// unseal must reconstruct.

import { type SealedRecord } from "@webhook-co/shared";

/** The envelope columns common to provider_secrets and signing_keys (migration 0003 shape). */
export interface SealedSecretColumns {
  readonly secret_ciphertext: Buffer;
  readonly enc_nonce: Buffer;
  readonly wrapped_dek: Buffer;
  readonly kek_ref: string;
  readonly envelope_version: number;
}

/** Map the shared envelope columns to a SealedRecord for unsealing (the single source of that shape). */
export function toSealedRecord(row: SealedSecretColumns): SealedRecord {
  return {
    ciphertext: row.secret_ciphertext,
    nonce: row.enc_nonce,
    wrapped: { wrappedDek: row.wrapped_dek, kekRef: row.kek_ref },
    envelopeVersion: row.envelope_version,
  };
}
