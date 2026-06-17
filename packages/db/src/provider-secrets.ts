// Provider signing-secret storage + retrieval (the inbound-verification secrets).
//
// A provider secret (Stripe webhook secret, GitHub HMAC secret, ...) is sealed under the KMS
// envelope (SecretStore: a per-secret AES-256-GCM DEK, itself wrapped by a KEK held OUTSIDE the
// database) and stored as ciphertext ONLY -- the plaintext is never persisted (compliance: secrets
// in a KMS, never plaintext). The AAD binds {orgId, endpointId, keyId} so a sealed secret can't be
// unsealed under a different context (confused-deputy protection); we persist that context (enc_context)
// so a reader can rebuild the AAD and decrypt.
//
// getEndpointProviderSecrets is org-discovery-by-endpoint: the synchronous ingest verify path runs
// it on the resolved endpoint to gather the (non-revoked, newest-first) sealed secrets, then unseals
// them to feed the verify adapters. It reads as webhook_app (tenant context) or webhook_authn (the
// by-hash cold path, role-targeted SELECT policy + column grant, migration 0012) -- both see only
// the sealed columns; the plaintext exists nowhere in the DB.

import { randomUUID } from "node:crypto";

import { type EncryptionContext, type SealedRecord, type SecretStore } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";
import { type CachedSealedSecret } from "./credential-cache";

/** Usable rotation states for an endpoint's provider secret (revoked is excluded from reads). */
export type ProviderSecretStatus = "active" | "retiring" | "revoked";

export interface AddProviderSecretInput {
  readonly orgId: string;
  readonly endpointId: string;
  /** The detected/declared provider scheme (e.g. "stripe", "github"). */
  readonly provider: string;
  /** Optional non-secret display label. */
  readonly label?: string;
  /** The plaintext signing secret — sealed here, never stored. */
  readonly plaintext: string;
}

export interface AddedProviderSecret {
  readonly id: string;
  readonly provider: string;
  readonly status: ProviderSecretStatus;
}

/** A retrieved sealed secret + the context needed to unseal it. */
export interface SealedProviderSecret {
  readonly id: string;
  readonly provider: string;
  readonly status: ProviderSecretStatus;
  /** The envelope-sealed record (ciphertext, nonce, wrapped DEK + kekRef, envelope version). */
  readonly sealed: SealedRecord;
  /** The AAD context ({orgId, endpointId, keyId}) rebuilt from enc_context, for unsealing. */
  readonly context: EncryptionContext;
}

/**
 * Seal a plaintext provider secret and store it (status 'active'). Runs as webhook_app under the
 * org's RLS context. The row id IS the AAD keyId, so the seal context is self-describing from the
 * stored row. Returns the new id/provider/status; the plaintext is sealed and never persisted.
 */
export async function addProviderSecret(
  app: Sql,
  input: AddProviderSecretInput,
  store: SecretStore,
): Promise<AddedProviderSecret> {
  const id = randomUUID();
  const context: EncryptionContext = {
    orgId: input.orgId,
    endpointId: input.endpointId,
    keyId: id,
  };
  const sealed = await store.sealString(input.plaintext, context);
  await withTenant(app, input.orgId, async (tx) => {
    // enc_context is jsonb — bind via tx.json so postgres.js serializes it EXACTLY once. A manual
    // JSON.stringify(...)::jsonb double-encodes (postgres.js re-encodes the string, storing a jsonb
    // STRING, not the object) — the same antipattern fixed in ingest-event.ts. This column is
    // audit-only (unseal rebuilds the AAD from the row's id/org/endpoint columns, see below), so
    // nothing reads it today, but storing the correct shape keeps the audit row queryable as jsonb.
    await tx`
      insert into provider_secrets (
        id, endpoint_id, org_id, provider, label,
        secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, enc_context, envelope_version, status
      )
      values (
        ${id}, ${input.endpointId}, ${input.orgId}, ${input.provider}, ${input.label ?? null},
        ${Buffer.from(sealed.ciphertext)}, ${Buffer.from(sealed.wrapped.wrappedDek)},
        ${sealed.wrapped.kekRef}, ${Buffer.from(sealed.nonce)}, ${tx.json(context as unknown as Parameters<typeof tx.json>[0])}::jsonb,
        ${sealed.envelopeVersion}, 'active'
      )`;
  });
  return { id, provider: input.provider, status: "active" };
}

interface ProviderSecretRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  provider: string;
  status: ProviderSecretStatus;
  secret_ciphertext: Buffer;
  wrapped_dek: Buffer;
  kek_ref: string;
  enc_nonce: Buffer;
  envelope_version: number;
}

function toSealed(row: ProviderSecretRow): SealedProviderSecret {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    sealed: {
      ciphertext: row.secret_ciphertext,
      nonce: row.enc_nonce,
      wrapped: { wrappedDek: row.wrapped_dek, kekRef: row.kek_ref },
      envelopeVersion: row.envelope_version,
    },
    // The AAD context is rebuilt from the AUTHORITATIVE row columns, not the stored enc_context
    // jsonb: keyId === id (addProviderSecret binds it so), endpointId/orgId are columns. This keeps
    // the unseal AAD tied to the row's identity (a tampered/stale enc_context can't mis-bind it) and
    // drops the redundant jsonb read + parse. enc_context is retained on the row for audit only.
    context: { orgId: row.org_id, endpointId: row.endpoint_id, keyId: row.id },
  };
}

/**
 * Convert a retrieved sealed secret to its JSON-SAFE cached form (byte fields -> base64) for
 * carrying on the resolved principal through the KV cache. The Buffer<->base64 marshalling lives in
 * this node-typed package so it type-checks against Buffer; at runtime it runs under the engine's
 * nodejs_compat (the same way insertIngestEvent / createCredentialHasherFromBase64 use Buffer in the
 * Worker). The inverse is fromCachedSealedSecret.
 */
export function toCachedSealedSecret(secret: SealedProviderSecret): CachedSealedSecret {
  return {
    id: secret.id,
    provider: secret.provider,
    ciphertextB64: Buffer.from(secret.sealed.ciphertext).toString("base64"),
    nonceB64: Buffer.from(secret.sealed.nonce).toString("base64"),
    wrappedDekB64: Buffer.from(secret.sealed.wrapped.wrappedDek).toString("base64"),
    kekRef: secret.sealed.wrapped.kekRef,
    envelopeVersion: secret.sealed.envelopeVersion,
    context: { ...secret.context }, // own copy (symmetry with fromCachedSealedSecret; no aliasing)
  };
}

/** Rebuild a usable {sealed record, AAD context, provider} from the JSON-safe cached form. */
export function fromCachedSealedSecret(cached: CachedSealedSecret): {
  readonly provider: string;
  readonly sealed: SealedRecord;
  readonly context: EncryptionContext;
} {
  return {
    provider: cached.provider,
    sealed: {
      ciphertext: Buffer.from(cached.ciphertextB64, "base64"),
      nonce: Buffer.from(cached.nonceB64, "base64"),
      wrapped: { wrappedDek: Buffer.from(cached.wrappedDekB64, "base64"), kekRef: cached.kekRef },
      envelopeVersion: cached.envelopeVersion,
    },
    context: { ...cached.context },
  };
}

/**
 * Resolve an endpoint's usable (non-revoked) sealed provider secrets, newest first (rotation:
 * verify tries newest first). `sql` connects as webhook_authn on the ingest cold path — the
 * role-targeted `using(true)` SELECT policy + column grant (migration 0012) resolves the row with
 * no prior tenant context (org-discovery-by-endpoint). A webhook_app caller must instead run inside
 * a tenant transaction (its policy gates on current_org_id()). Returns the sealed records + their
 * unseal contexts; the caller unseals via SecretStore.open to feed the verify adapters.
 */
export async function getEndpointProviderSecrets(
  sql: Sql,
  endpointId: string,
): Promise<SealedProviderSecret[]> {
  // order by (created_at desc, id desc): the id tiebreak makes rotation order deterministic when
  // two secrets share a created_at (verify tries them all, but a stable order keeps reported keyIds
  // reproducible). Served by provider_secrets_endpoint_idx (migration 0012).
  const rows = await sql<ProviderSecretRow[]>`
    select id, org_id, endpoint_id, provider, status, secret_ciphertext, wrapped_dek, kek_ref,
           enc_nonce, envelope_version
    from provider_secrets
    where endpoint_id = ${endpointId} and status in ('active', 'retiring')
    order by created_at desc, id desc`;
  return rows.map(toSealed);
}

/**
 * Revoke a provider secret by id (status -> 'revoked') under the org's RLS context. A revoked secret
 * is excluded from getEndpointProviderSecrets, so the verify path stops honoring it. Returns true iff
 * a row transitioned -- a missing / cross-org (RLS-invisible) / already-revoked id yields false.
 *
 * Like revokeApiKey, this touches ONLY the row of record. The CALLER is responsible for (a) appending
 * the control-plane audit entry and (b) invalidating the ingest resolver's cached principal for the
 * endpoint -- the revoked secret rides on that cached principal (sealedSecrets snapshot) until the KV
 * entry is evicted, so without invalidation a forged signature keeps verifying until the TTL backstop.
 * Derive the eviction key with getEndpointIngestTokenHash + resolver.invalidateHash (see ADR-0015).
 */
export async function revokeProviderSecret(app: Sql, orgId: string, id: string): Promise<boolean> {
  const count = await withTenant(app, orgId, async (tx) => {
    const res = await tx`
      update provider_secrets set status = 'revoked'
      where id = ${id} and status <> 'revoked'`;
    return res.count;
  });
  return count > 0;
}

/**
 * Retire a provider secret by id (status 'active' -> 'retiring') under the org's RLS context. Retiring
 * is the rotation grace state, NOT a revocation: getEndpointProviderSecrets still returns 'retiring'
 * secrets, so the verify path keeps honoring it. Returns true iff an ACTIVE row transitioned (already
 * retiring/revoked, missing, or cross-org -> false).
 *
 * No cache invalidation is required for retire on its own: the cached principal carries the secret's
 * ciphertext (not its status), and the honored set is unchanged, so verification behaviour does not
 * change. (Revocation, which removes the secret from the honored set, is the case that needs eviction.)
 */
export async function retireProviderSecret(app: Sql, orgId: string, id: string): Promise<boolean> {
  const count = await withTenant(app, orgId, async (tx) => {
    const res = await tx`
      update provider_secrets set status = 'retiring'
      where id = ${id} and status = 'active'`;
    return res.count;
  });
  return count > 0;
}
