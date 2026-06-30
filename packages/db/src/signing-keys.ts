// Outbound Standard Webhooks signing-secret storage (S3 Slice 2, ADR-0084).
//
// A signing secret is webhook.co-MINTED (generateSigningSecret), scoped PER RECEIVING DESTINATION
// (the Standard Webhooks model: one secret per receiver), sealed under the KMS envelope (SecretStore:
// a per-secret AES-256-GCM DEK wrapped by a KEK held OUTSIDE the database) and stored as ciphertext
// ONLY — the plaintext is revealed to the destination owner exactly ONCE at create/rotate and never
// persisted. The engine unseals it at delivery to sign. signing_keys is multi-row-per-destination with
// status (active/retiring/revoked) so rotation can overlap (two signatures, space-delimited) without
// downtime. The AAD binds {orgId, endpointId: destinationId, keyId} so a sealed secret can't be unsealed
// under a different context.

import { randomUUID } from "node:crypto";

import {
  generateSigningSecret,
  type EncryptionContext,
  type SealedRecord,
  type SecretSealer,
} from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql, type TenantTx } from "./client";
import { toSealedRecord } from "./sealed-secret";

/** Rotation states for a destination's signing secret (revoked is excluded from the honored set). */
export type SigningKeyStatus = "active" | "retiring" | "revoked";

/**
 * Control-plane audit context for a signing-secret mutation (create/rotate). When supplied, a
 * tamper-evident wha1/audit_log row is appended IN THE SAME tx (atomic with the mutation), for parity
 * with the provider-secret + endpoint lifecycle. The HMAC key comes from a runtime binding, never the
 * DB role. Optional so the low-level db tests can run without an audit key.
 */
export interface SigningSecretAudit {
  readonly auditKey: CryptoKey;
  /** Pseudonymous actor (Better Auth user_id), or null for api-key/system actors. */
  readonly actor: string | null;
}

export interface CreateSigningSecretInput {
  readonly orgId: string;
  readonly destinationId: string;
}

export interface CreatedSigningSecret {
  readonly keyId: string;
  /** The `whsec_` plaintext — revealed to the destination owner ONCE; only the seal is kept. */
  readonly secret: string;
}

/** A retrieved sealed signing secret + the AAD context needed to unseal it (engine-side). */
export interface SealedSigningSecret {
  readonly id: string;
  readonly status: SigningKeyStatus;
  readonly sealed: SealedRecord;
  readonly context: EncryptionContext;
}

/** A destination's signing secret as NON-secret metadata — never the sealed bytes or the plaintext. */
export interface SigningSecretMetadata {
  readonly id: string;
  readonly status: SigningKeyStatus;
  readonly createdAt: Date;
}

interface SigningKeyRow {
  id: string;
  org_id: string;
  destination_id: string;
  status: SigningKeyStatus;
  secret_ciphertext: Buffer;
  wrapped_dek: Buffer;
  kek_ref: string;
  enc_nonce: Buffer;
  envelope_version: number;
}

/**
 * Mint a fresh signing secret, seal it, and insert it as 'active' within an existing tenant tx. The row
 * id IS the AAD keyId (self-describing seal context). Returns the keyId + the `whsec_` plaintext (the
 * single reveal). Shared by create + rotate.
 */
export async function insertActiveSigningSecret(
  tx: TenantTx,
  orgId: string,
  destinationId: string,
  sealer: SecretSealer,
): Promise<CreatedSigningSecret> {
  const id = randomUUID();
  const secret = generateSigningSecret();
  // endpointId carries the DESTINATION id (the receiver this secret signs for); keyId === the row id, so
  // the AAD is unique per row. The engine rebuilds the identical context to unseal (no cross-context use).
  const context: EncryptionContext = { orgId, endpointId: destinationId, keyId: id };
  const sealed = await sealer.sealString(secret, context);
  // enc_context is jsonb — bind via tx.json so postgres.js serializes it EXACTLY once (a manual
  // JSON.stringify(...)::jsonb double-encodes). Audit-only: unseal rebuilds the AAD from the row columns.
  await tx`
    insert into signing_keys (
      id, destination_id, org_id,
      secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, enc_context, envelope_version, status
    )
    values (
      ${id}, ${destinationId}, ${orgId},
      ${Buffer.from(sealed.ciphertext)}, ${Buffer.from(sealed.wrapped.wrappedDek)}, ${sealed.wrapped.kekRef},
      ${Buffer.from(sealed.nonce)}, ${tx.json(context as unknown as Parameters<typeof tx.json>[0])}::jsonb,
      ${sealed.envelopeVersion}, 'active'
    )`;
  return { keyId: id, secret };
}

/**
 * Create a destination's first signing secret (status 'active') under the org's RLS context. Generates
 * the `whsec_` secret, seals it via the write-only sealer seam (a local SecretStore in tests, the
 * engine's remote sealer in prod), stores only the ciphertext, and returns the plaintext for its single
 * reveal. The composite (destination_id, org_id) FK + RLS reject a cross-org / unknown destination.
 */
export async function createSigningSecret(
  app: Sql,
  input: CreateSigningSecretInput,
  sealer: SecretSealer,
  audit?: SigningSecretAudit,
): Promise<CreatedSigningSecret> {
  return withTenant(app, input.orgId, async (tx) => {
    const created = await insertActiveSigningSecret(tx, input.orgId, input.destinationId, sealer);
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "signing_secret.created",
        target: created.keyId,
      });
    }
    return created;
  });
}

/**
 * Rotate a destination's signing secret with a bounded zero-downtime overlap. In one tx: revoke any
 * already-retiring key (its grace ended), retire the current active, then mint a fresh active — so the
 * honored set is at most {active, retiring} (two space-delimited signatures during overlap). Returns the
 * new active secret's single reveal.
 */
export async function rotateSigningSecret(
  app: Sql,
  input: CreateSigningSecretInput,
  sealer: SecretSealer,
  audit?: SigningSecretAudit,
): Promise<CreatedSigningSecret> {
  return withTenant(app, input.orgId, async (tx) => {
    await tx`update signing_keys set status = 'revoked'
             where destination_id = ${input.destinationId} and status = 'retiring'`;
    await tx`update signing_keys set status = 'retiring'
             where destination_id = ${input.destinationId} and status = 'active'`;
    const created = await insertActiveSigningSecret(tx, input.orgId, input.destinationId, sealer);
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "signing_secret.rotated",
        target: created.keyId,
      });
    }
    return created;
  });
}

/**
 * The honored (non-revoked) signing secrets for a destination, NEWEST FIRST (the fresh active leads the
 * space-delimited `webhook-signature` header). Runs inside the caller's tenant tx (webhook_app under
 * RLS) — the api fetches these on the remote-replay path and hands the SEALED records to the engine,
 * which unseals + signs. The sealed bytes never leave the engine; the api only relays ciphertext.
 */
export async function getActiveSigningSecrets(
  tx: TenantTx,
  destinationId: string,
): Promise<SealedSigningSecret[]> {
  const rows = await tx<SigningKeyRow[]>`
    select id, org_id, destination_id, status, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version
    from signing_keys
    where destination_id = ${destinationId} and status in ('active', 'retiring')
    order by created_at desc, id desc`;
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    sealed: toSealedRecord(row),
    // AAD rebuilt from authoritative row columns (keyId === id; endpointId carries destination_id).
    context: { orgId: row.org_id, endpointId: row.destination_id, keyId: row.id },
  }));
}

/**
 * List a destination's signing secrets as metadata only (id/status/createdAt), newest-first, under the
 * org's RLS context — the management surface. CRITICAL: SELECTs no ciphertext / wrapped-DEK / nonce
 * columns, so the sealed bytes and the plaintext never leave the DB through this read. Includes revoked
 * keys (full history for the operator).
 */
export async function listSigningSecrets(
  app: Sql,
  orgId: string,
  destinationId: string,
): Promise<SigningSecretMetadata[]> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) => tx<{ id: string; status: SigningKeyStatus; created_at: Date }[]>`
      select id, status, created_at from signing_keys
      where destination_id = ${destinationId}
      order by created_at desc, id desc`,
  );
  return rows.map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at }));
}
