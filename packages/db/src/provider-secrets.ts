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

import { CapabilityFault } from "@webhook-co/contract";
import {
  PROVIDERS,
  serializeProviderSecretPlaintext,
  validateProviderSecretShape,
  type EncryptionContext,
  type Provider,
  type ProviderSecretKind,
  type SealedRecord,
  type SecretSealer,
} from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";
import { type CachedSealedSecret } from "./credential-cache";
import { getEndpointIngestTokenHash } from "./endpoints";
import { toSealedRecord } from "./sealed-secret";

/** Usable rotation states for an endpoint's provider secret (revoked is excluded from reads). */
export type ProviderSecretStatus = "active" | "retiring" | "revoked";

/**
 * Control-plane audit context for a provider-secret mutation (add/revoke). When supplied, the mutation
 * appends a tamper-evident wha1/audit_log row IN THE SAME tx (atomic with the insert/update), for parity
 * with the endpoints lifecycle (endpoint.created/.deleted/.rotated). The HMAC key comes from a runtime
 * binding, never the DB role (ADR-0004). Optional so the low-level db-function tests can exercise the
 * mutation without an audit key; the management handlers always supply it.
 */
export interface ProviderSecretAudit {
  readonly auditKey: CryptoKey;
  /** Pseudonymous actor (Better Auth user_id), or null for api-key/system actors. */
  readonly actor: string | null;
}

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
  sealer: SecretSealer,
  audit?: ProviderSecretAudit,
): Promise<AddedProviderSecret> {
  const id = randomUUID();
  const context: EncryptionContext = {
    orgId: input.orgId,
    endpointId: input.endpointId,
    keyId: id,
  };
  // Seal via the narrow write-only seam: a local SecretStore in tests, the engine's remote sealer in
  // prod (api/mcp delegate to it over a service binding, never holding the KEK — ADR-0078 / D1).
  const sealed = await sealer.sealString(input.plaintext, context);
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
    // Same tx, same RLS context: the control-plane audit row (parity with endpoint.created). The
    // secret id is the audit target; the plaintext/ciphertext is never in the audit row.
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "provider_secret.added",
        target: id,
      });
    }
  });
  return { id, provider: input.provider, status: "active" };
}

/**
 * The per-endpoint provider-secret cap. `RATE_LIMITED` is declared on all three capabilities; this is the
 * value that enforces it (a runaway/abuse guardrail, generous for legit multi-provider × multi-kind × the
 * rotation overlap). Shared so api/mcp/web can't drift.
 */
export const MAX_PROVIDER_SECRETS_PER_ENDPOINT = 25;

/** Count an endpoint's LIVE (active + retiring) provider secrets, under the org's RLS context. */
export async function countLiveProviderSecrets(
  app: Sql,
  orgId: string,
  endpointId: string,
): Promise<number> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ n: string }[]>`
      select count(*)::text as n from provider_secrets
      where endpoint_id = ${endpointId} and status in ('active', 'retiring')`;
    return row ? Number(row.n) : 0;
  });
}

/** The registration input — a raw (un-serialized) secret + its kind; the core serializes by kind. */
export interface RegisterProviderSecretInput {
  readonly orgId: string;
  readonly endpointId: string;
  readonly provider: Provider;
  readonly kind: ProviderSecretKind;
  /** The RAW plaintext secret as the operator typed it — serialized by kind here, sealed by addProviderSecret. */
  readonly secret: string;
  readonly label?: string;
}

/** The runtime boundaries the core needs — the same sealer/evict/audit the api/mcp handlers already hold. */
export interface RegisterProviderSecretDeps {
  readonly sealer: SecretSealer;
  /** Best-effort eviction of the endpoint's ingest-token hash from the KV verify cache. */
  readonly evict: (tokenHash: Buffer) => Promise<void>;
  readonly auditKey: CryptoKey;
  readonly actor: string | null;
}

/**
 * Register a provider secret — the SINGLE shared write core called by api/mcp (the capability handler) AND
 * web (the dashboard action), so the security-critical order can't drift. Canonical order (matches the
 * proven api handler): resolve the endpoint (NOT_FOUND **before** any seal — never seal against a bad/
 * cross-org endpoint) → validate the (provider, kind, secret) shape (VALIDATION_ERROR) → enforce the
 * per-endpoint cap (RATE_LIMITED) → serialize the secret to its typed blob by kind (the corruption-critical
 * step — verify_token/braintree must be wrapped, never stored raw) → seal + insert + in-tx audit
 * (addProviderSecret) → best-effort KV evict so the new secret is honored on the NEXT ingest. Throws a
 * `CapabilityFault` for each failure (the surface maps it to its transport). The plaintext is sealed, never
 * persisted or returned.
 */
export async function registerProviderSecret(
  app: Sql,
  input: RegisterProviderSecretInput,
  deps: RegisterProviderSecretDeps,
): Promise<AddedProviderSecret> {
  // 1. Validate the FULL input FIRST — before the endpoint lookup, matching the api/mcp handler's
  //    safeParse-first precedence (so the same input yields the same error CODE on every surface, and a bad
  //    input never reveals endpoint (non)existence). This is the SOLE input gate on the zod-less web path, so
  //    it must enforce the SAME base constraints the contract zod does — provider ∈ PROVIDERS, kind ∈ the
  //    3-value enum, secret 1..4096, label ≤200 — not only the per-kind shape refine. (Redundant but harmless
  //    for the api/mcp path, whose contract safeParse already ran the identical checks.)
  if (!(PROVIDERS as readonly string[]).includes(input.provider)) {
    throw new CapabilityFault("VALIDATION_ERROR", "unknown provider");
  }
  if (
    input.kind !== "signing_secret" &&
    input.kind !== "verify_token" &&
    input.kind !== "braintree_public_key"
  ) {
    throw new CapabilityFault("VALIDATION_ERROR", "unknown secret kind");
  }
  if (typeof input.secret !== "string" || input.secret.length < 1 || input.secret.length > 4096) {
    throw new CapabilityFault("VALIDATION_ERROR", "a secret must be 1–4096 characters");
  }
  if (input.label != null && input.label.length > 200) {
    throw new CapabilityFault("VALIDATION_ERROR", "a label must be at most 200 characters");
  }
  const shape = validateProviderSecretShape({
    provider: input.provider,
    kind: input.kind,
    secret: input.secret,
  });
  if (!shape.ok) throw new CapabilityFault("VALIDATION_ERROR", shape.message);
  // 2. Endpoint existence — NOT_FOUND before any seal, and the hash to evict. (The FK would also reject a bad
  //    endpoint, but as a 500, not a 404.) RLS-scoped, so a cross-org endpoint is NOT_FOUND, not visible.
  const tokenHash = await getEndpointIngestTokenHash(app, input.orgId, input.endpointId);
  if (tokenHash === null) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
  // 3. Per-endpoint cap. A tiny check-then-insert race (like the endpoints-per-org cap) can transiently
  //    yield cap+1 — a benign guardrail, not a security boundary.
  const live = await countLiveProviderSecrets(app, input.orgId, input.endpointId);
  if (live >= MAX_PROVIDER_SECRETS_PER_ENDPOINT) {
    throw new CapabilityFault(
      "RATE_LIMITED",
      "this endpoint has reached its provider-secret limit",
    );
  }
  // 4. Serialize by kind (verify_token/braintree → typed blob; signing_secret → raw), then 5. seal + insert
  //    + in-tx audit (addProviderSecret seals whatever plaintext it's handed).
  const added = await addProviderSecret(
    app,
    {
      orgId: input.orgId,
      endpointId: input.endpointId,
      provider: input.provider,
      label: input.label,
      plaintext: serializeProviderSecretPlaintext(input.kind, input.secret),
    },
    deps.sealer,
    { auditKey: deps.auditKey, actor: deps.actor },
  );
  // 6. Best-effort evict so the new secret is honored on the NEXT ingest, not after the KV TTL. The secret is
  //    ALREADY durably sealed+inserted+audited, so a transient evict failure must NOT throw (that would make
  //    the caller retry and store a duplicate) — swallow it, exactly as the revoke path does.
  try {
    await deps.evict(tokenHash);
  } catch (err) {
    console.log(
      JSON.stringify({ message: "provider_secret.register_evict_failed", error: String(err) }),
    );
  }
  return added;
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
    // The envelope row→SealedRecord shape is single-sourced (toSealedRecord), shared with signing_keys
    // so the inbound + outbound sealed-secret readers can't drift on the on-disk envelope encoding.
    sealed: toSealedRecord(row),
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

export interface RevokeProviderSecretInput {
  readonly orgId: string;
  /** The endpoint the secret must belong to — makes this endpointId authoritative for KV eviction. */
  readonly endpointId: string;
  readonly secretId: string;
}

/**
 * Revoke a provider secret BELONGING TO an endpoint (status -> 'revoked') under the org's RLS context;
 * returns its revoke time, or null if no active/retiring secret with that id belongs to the endpoint
 * (unknown / cross-org / already-revoked / wrong-endpoint -> null). A revoked secret is excluded from
 * getEndpointProviderSecrets, so the verify path stops honoring it. Scoping by endpoint_id (NOT just
 * id) is the eviction-correctness guard: a secret id from a DIFFERENT endpoint can't be revoked here,
 * so the caller's endpointId is always the one to evict (no cross-endpoint cache miss — ADR-0015).
 *
 * The CALLER must then invalidate the endpoint's cached principal — the revoked secret rides on the KV
 * sealedSecrets snapshot until evicted, so without it a signature made with the revoked secret keeps
 * verifying until the TTL backstop. Derive the key via getEndpointIngestTokenHash + invalidateHash.
 *
 * When `audit` is supplied, a `provider_secret.revoked` wha1 row is appended in the SAME tx — but only
 * if a row actually transitioned (a no-op revoke of an unknown/already-revoked secret writes no audit).
 */
export async function revokeProviderSecret(
  app: Sql,
  input: RevokeProviderSecretInput,
  audit?: ProviderSecretAudit,
): Promise<{ readonly id: string; readonly revokedAt: Date } | null> {
  const rows = await withTenant(app, input.orgId, async (tx) => {
    const updated = await tx<{ revoked_at: Date }[]>`
      update provider_secrets set status = 'revoked'
      where id = ${input.secretId} and endpoint_id = ${input.endpointId} and status <> 'revoked'
      returning now()::timestamptz as revoked_at`;
    // Audit only a real transition (updated.length > 0): a no-op revoke leaves the chain untouched.
    if (updated.length > 0 && audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "provider_secret.revoked",
        target: input.secretId,
      });
    }
    return updated;
  });
  const row = rows[0];
  return row ? { id: input.secretId, revokedAt: row.revoked_at } : null;
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

/** An endpoint's provider secret as NON-secret metadata — never the sealed bytes or the plaintext. */
export interface ProviderSecretMetadata {
  readonly id: string;
  readonly provider: string;
  readonly status: ProviderSecretStatus;
  readonly label: string | null;
  readonly createdAt: Date;
}

/**
 * List an endpoint's provider secrets as metadata only (id/provider/status/label/createdAt),
 * newest-first, under the org's RLS context (webhook_app) — the management `listProviderSecrets`
 * surface. CRITICAL: this SELECTs no ciphertext / wrapped-DEK / nonce columns, so the sealed bytes
 * and the plaintext never leave the DB through this read. Includes revoked secrets too (the operator
 * sees full history), unlike getEndpointProviderSecrets which the verify path filters to the honored set.
 */
export async function listEndpointProviderSecrets(
  app: Sql,
  orgId: string,
  endpointId: string,
): Promise<ProviderSecretMetadata[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<
      {
        id: string;
        provider: string;
        status: ProviderSecretStatus;
        label: string | null;
        created_at: Date;
      }[]
    >`
      select id, provider, status, label, created_at
      from provider_secrets
      where endpoint_id = ${endpointId}
      order by created_at desc, id desc`;
  });
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    label: r.label,
    createdAt: r.created_at,
  }));
}
