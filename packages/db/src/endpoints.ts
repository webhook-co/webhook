// Endpoint creation + the webhook_authn endpoint-token COLD lookup.
//
// createEndpoint mints the wbhk.my/<token> path token (a CSPRNG >=256-bit secret) via the
// shared credential primitive, stores ONLY its peppered HMAC-SHA256 hash in
// endpoints.ingest_token_hash, and returns the plaintext token exactly once. (ADR-0008
// hashing posture; ADR-0003 reconciled to the shared primitive -- the token hash is a
// keyed HMAC, not a bare sha256, so a DB-only leak yields inert hashes.)
//
// makeEndpointTokenColdLookup is ORG-DISCOVERY-BY-HASH: the ingest path runs it on a KV
// cache miss to resolve a presented path token to its owning {org, endpoint} BEFORE any
// tenant context exists. It connects as webhook_authn (the by-hash credential-resolution
// role; migration 0011 grants it a role-targeted SELECT policy + a column-scoped grant on
// endpoints) through the CACHE-DISABLED Hyperdrive binding. KV is the only hot cache, and
// it can be invalidated on pause/rotate/delete -- Hyperdrive's query cache cannot.

import { randomUUID } from "node:crypto";

// Import CapabilityFault from the LEAF (not the `@webhook-co/contract` barrel): apps/web pulls this module
// (DB-direct endpoint mutations) under Turbopack/OpenNext, where a named binding from a transpiled-package
// `export *` barrel resolves to `undefined` at runtime — so a barrel import would make `new CapabilityFault`
// throw "not a constructor" on the error paths (RATE_LIMITED / NOT_FOUND). The leaf resolves reliably
// everywhere (see [[turbopack-contract-barrel]]; same leaf apps/web already uses for CAPABILITY_SCOPES).
import { CapabilityFault } from "@webhook-co/contract/capability";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";
import { credentialHashEquals, mintCredential, type CredentialHasher } from "./credential";
import type { ResolvedPrincipal } from "./credential-cache";

/** Display + path prefix for ingest tokens (the wbhk.my/<token> path token). */
export const INGEST_TOKEN_PREFIX = "whep";

/**
 * Per-org advisory-lock namespace (the second arg to hashtextextended) that serializes concurrent
 * endpoint creates for an org, so the soft cap is EXACT rather than best-effort. Distinct from the
 * audit-chain namespaces so it never contends with them. ("ENDP".)
 */
const ENDPOINT_CREATE_LOCK_NAMESPACE = 0x454e4450;

export interface CreateEndpointInput {
  readonly orgId: string;
  readonly name: string;
}

export interface CreatedEndpoint {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly paused: boolean;
  readonly start: string;
  /** The plaintext ingest token -- returned ONCE, never persisted. Surface it now. */
  readonly plaintext: string;
}

/**
 * Create an endpoint and mint its ingest token. The token is a CSPRNG >=256-bit secret;
 * only its peppered HMAC-SHA256 hash is stored (endpoints.ingest_token_hash). Runs as
 * webhook_app under the org's RLS context. The edge generates the uuid id (randomUUID()
 * stand-in, like createApiKey).
 */
export async function createEndpoint(
  app: Sql,
  input: CreateEndpointInput,
  hasher: CredentialHasher,
): Promise<CreatedEndpoint> {
  const { plaintext, keyHash, start } = mintCredential(INGEST_TOKEN_PREFIX, hasher);
  const id = randomUUID();
  await withTenant(app, input.orgId, async (tx) => {
    await tx`
      insert into endpoints (id, org_id, ingest_token_hash, name)
      values (${id}, ${input.orgId}, ${keyHash}, ${input.name})`;
  });
  return { id, orgId: input.orgId, name: input.name, paused: false, start, plaintext };
}

/**
 * Per-org endpoint soft cap (ADR-0075): the abuse backstop the create path enforces EXACTLY under the
 * per-org advisory lock; counts LIVE endpoints (delete relieves it). The SINGLE source of truth for the cap
 * across every surface — api/mcp pass it via the write handler, the dashboard (DB-direct) imports it here.
 */
export const DEFAULT_MAX_ENDPOINTS_PER_ORG = 100;

export interface CreateEndpointWithAuditInput extends CreateEndpointInput {
  /** Acting principal (Better Auth user_id) for the audit row, or null for an api-key bearer. */
  readonly actor: string | null;
  /** Per-org endpoint soft cap (ADR-0075). Exceeding it throws RATE_LIMITED — an abuse backstop. */
  readonly maxEndpoints: number;
}

export interface CreatedEndpointRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly paused: boolean;
  readonly createdAt: Date;
  /** Plaintext ingest token — returned ONCE; the wbhk.my URL that embeds it is the one-time reveal. */
  readonly plaintext: string;
}

/**
 * Create an endpoint, mint its ingest token, AND append a tamper-evident control-plane audit row — all
 * in ONE transaction under the org's RLS context (webhook_app). The audited variant used by the
 * endpoints.create capability; the bare createEndpoint above (own tx, no audit) is kept for the
 * operator bootstrap. This MUST be its own tx (it does NOT call createEndpoint, which opens a separate
 * one) so the endpoint row and its wha1/audit_log row commit or roll back together. A per-org advisory
 * lock is taken first, so the soft-cap check (BEFORE the mint/insert; an over-cap call neither mints a
 * token nor writes audit) is EXACT under concurrency — not best-effort. The cap is an abuse backstop; it
 * counts only LIVE endpoints (deleted_at is null), so endpoints.delete (ADR-0076) relieves it.
 */
export async function createEndpointWithAudit(
  app: Sql,
  input: CreateEndpointWithAuditInput,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<CreatedEndpointRow> {
  const { plaintext, keyHash } = mintCredential(INGEST_TOKEN_PREFIX, hasher);
  const id = randomUUID();
  const createdAt = await withTenant(app, input.orgId, async (tx) => {
    // Serialize concurrent creates for THIS org (transaction-scoped, released on commit/rollback) so the
    // soft-cap check below is exact rather than racy (cap+N under a burst). Creates are infrequent, so
    // the per-org serialization is cheap; it never contends with the audit lock (distinct namespace).
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, ${ENDPOINT_CREATE_LOCK_NAMESPACE}))`;
    // Counts only THIS org's LIVE rows (RLS pins app.current_org; `deleted_at is null` excludes
    // soft-deleted endpoints, ADR-0076 — so endpoints.delete actually relieves the cap). bigint -> int4.
    const countRows = await tx<{ count: number }[]>`
      select count(*)::int as count from endpoints where deleted_at is null`;
    const count = countRows[0]?.count ?? 0;
    if (count >= input.maxEndpoints) {
      throw new CapabilityFault(
        "RATE_LIMITED",
        `endpoint limit reached (${input.maxEndpoints} per org)`,
      );
    }
    const rows = await tx<{ created_at: Date }[]>`
      insert into endpoints (id, org_id, ingest_token_hash, name)
      values (${id}, ${input.orgId}, ${keyHash}, ${input.name})
      returning created_at`;
    const inserted = rows[0];
    if (!inserted) throw new Error("createEndpointWithAudit: insert returned no row");
    // Same tx, same RLS context: the control-plane audit event (wha1/audit_log). actor may be null
    // (api-key bearers carry no user_id); audit_log.actor is nullable text.
    await appendAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.actor,
      action: "endpoint.created",
      target: id,
    });
    return inserted.created_at;
  });
  return { id, orgId: input.orgId, name: input.name, paused: false, createdAt, plaintext };
}

export interface DeleteEndpointInput {
  readonly orgId: string;
  readonly endpointId: string;
  /** Acting principal (Better Auth user_id) for the audit row, or null for an api-key bearer. */
  readonly actor: string | null;
}

export interface DeletedEndpointRow {
  readonly id: string;
  /** When the endpoint was soft-deleted (the original time on an idempotent re-delete). */
  readonly deletedAt: Date;
  /** The stored ingest-token hash — the caller evicts it from the KV ingest cache to stop ingest now. */
  readonly tokenHash: Buffer;
  /** True on the state transition (this call did the delete); false on an idempotent re-delete. */
  readonly wasLive: boolean;
}

/**
 * SOFT-delete an endpoint (set deleted_at) and append the control-plane audit row, in ONE tx under the
 * org's RLS context (webhook_app). Returns the stored ingest-token hash so the caller evicts the KV
 * ingest cache — the immediate stop; the durable stop is the cold lookup's `deleted_at is null` filter,
 * which also self-heals within the KV TTL if an eviction is missed. IDEMPOTENT: a re-delete of an
 * already-deleted endpoint returns its recorded deletedAt and does NOT append a second audit row (the
 * transition happened once). An unknown / cross-org id is RLS-invisible -> CapabilityFault NOT_FOUND.
 * One statement: a `cur` CTE captures the prior deleted_at (so we know if this was the transition), then
 * `coalesce(deleted_at, now())` makes the write idempotent (already-deleted rows keep their time). The
 * `cur` select takes `for update` (like rotate) so two concurrent first-deletes of the same live endpoint
 * SERIALIZE — the second blocks, then re-reads prev_deleted_at as non-null (was_live=false) — instead of
 * both snapshotting null and each appending an `endpoint.deleted` row (audit-once-per-transition).
 */
export async function deleteEndpointWithAudit(
  app: Sql,
  input: DeleteEndpointInput,
  auditKey: CryptoKey,
): Promise<DeletedEndpointRow> {
  return withTenant(app, input.orgId, async (tx) => {
    const rows = await tx<{ ingest_token_hash: Buffer; deleted_at: Date; was_live: boolean }[]>`
      with cur as (
        select id, deleted_at as prev_deleted_at from endpoints where id = ${input.endpointId} for update
      )
      update endpoints e
         set deleted_at = coalesce(e.deleted_at, now())
        from cur
       where e.id = cur.id
      returning e.ingest_token_hash, e.deleted_at, (cur.prev_deleted_at is null) as was_live`;
    const row = rows[0];
    if (!row) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
    if (row.was_live) {
      // Audit ONLY the actual state transition (not an idempotent re-delete). Same tx + RLS context.
      await appendAuditEntry(tx, auditKey, {
        orgId: input.orgId,
        actor: input.actor,
        action: "endpoint.deleted",
        target: input.endpointId,
      });
    }
    return {
      id: input.endpointId,
      deletedAt: row.deleted_at,
      tokenHash: Buffer.from(row.ingest_token_hash),
      wasLive: row.was_live,
    };
  });
}

export interface RotateEndpointInput {
  readonly orgId: string;
  readonly endpointId: string;
  /** Acting principal (Better Auth user_id) for the audit row, or null for an api-key bearer. */
  readonly actor: string | null;
}

export interface RotatedEndpointRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly paused: boolean;
  readonly createdAt: Date;
  /** The OLD ingest-token hash — the caller evicts it from the KV ingest cache (the HARD cutover). */
  readonly oldTokenHash: Buffer;
  /** The NEW plaintext ingest token — returned ONCE; the wbhk.my URL embeds it (one-time reveal). */
  readonly plaintext: string;
}

/**
 * ROTATE a LIVE endpoint's ingest token IN PLACE (ADR-0076) and append the control-plane audit row, in
 * ONE tx under the org's RLS context (webhook_app). Mints a fresh token, swaps endpoints.ingest_token_hash
 * to the new hash (the `cur` CTE takes `for update` to serialize concurrent rotate/delete on the same
 * endpoint), and returns the OLD hash so the caller evicts it from the KV ingest cache — the HARD cutover
 * that kills the old URL. The endpoint id/name/paused/createdAt + its captured events and provider secrets
 * are preserved (unlike delete+recreate). A deleted / unknown / cross-org id is invisible -> NOT_FOUND.
 * (Even without the eviction the old token dies on the next cold miss — its hash matches no row — but the
 * eviction makes it immediate rather than within the KV TTL; the new token resolves immediately.)
 */
export async function rotateEndpointWithAudit(
  app: Sql,
  input: RotateEndpointInput,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<RotatedEndpointRow> {
  const { plaintext, keyHash } = mintCredential(INGEST_TOKEN_PREFIX, hasher);
  return withTenant(app, input.orgId, async (tx) => {
    const rows = await tx<{ old_hash: Buffer; name: string; paused: boolean; created_at: Date }[]>`
      with cur as (
        select ingest_token_hash as old_hash, name, paused, created_at
        from endpoints
        where id = ${input.endpointId} and deleted_at is null
        for update
      )
      update endpoints e set ingest_token_hash = ${keyHash}
        from cur
       where e.id = ${input.endpointId}
      returning cur.old_hash, cur.name, cur.paused, cur.created_at`;
    const row = rows[0];
    if (!row) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
    await appendAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.actor,
      action: "endpoint.rotated",
      target: input.endpointId,
    });
    return {
      id: input.endpointId,
      orgId: input.orgId,
      name: row.name,
      paused: row.paused,
      createdAt: row.created_at,
      oldTokenHash: Buffer.from(row.old_hash),
      plaintext,
    };
  });
}

/**
 * Read an endpoint's stored ingest-token hash (endpoints.ingest_token_hash), or null if no such
 * endpoint is visible under the org's RLS context. This is the CROSS-SURFACE INVALIDATION SEAM
 * (ADR-0015): a control-plane mutation that changes what the ingest resolver caches for an endpoint
 * -- today a provider-secret add/revoke, which changes the sealedSecrets snapshot carried on the
 * cached principal -- holds the endpoint id, not the wbhk.my path-token plaintext, so it cannot call
 * resolver.invalidate(plaintext). It instead evicts by hash: `resolver.invalidateHash(hash)` (== a KV
 * delete of credentialCacheKey(hash)). The resolver caches the principal under
 * credentialCacheKey(<the matched candidate hash>), which IS this stored hash, so the derived key
 * hits exactly that entry. Runs as webhook_app under the org's RLS context (the same posture as
 * createEndpoint / revokeApiKey); a cross-org or unknown id is RLS-invisible -> null. The token hash
 * is a keyed HMAC (inert without the pepper) and is already the public KV key, so returning it leaks
 * nothing the cache layer doesn't already expose.
 */
export async function getEndpointIngestTokenHash(
  app: Sql,
  orgId: string,
  endpointId: string,
): Promise<Buffer | null> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<{ ingest_token_hash: Buffer }[]>`
      select ingest_token_hash from endpoints where id = ${endpointId}`;
  });
  const row = rows[0];
  return row ? Buffer.from(row.ingest_token_hash) : null;
}

interface EndpointResolveRow {
  id: string;
  org_id: string;
  ingest_token_hash: Buffer;
  paused: boolean;
}

/**
 * The webhook_authn COLD lookup: resolve an ingest-token hash to its owning org +
 * endpoint (+ the paused flag the ingest guard reads), or null. ORG-DISCOVERY-BY-HASH --
 * the presented token determines its org; there is no expected org before the lookup
 * (webhook_authn holds a FOR SELECT TO webhook_authn USING(true) policy + a column-scoped
 * grant on endpoints, migration 0011). The lookup matches on equality, but we never resolve
 * a principal off an unverified compare -- re-check the stored hash against the queried hash
 * in constant time (defense-in-depth; that's what credentialHashEquals is for). Removal is a soft
 * delete (deleted_at, ADR-0076) and rotation swaps ingest_token_hash in place — both paired with a KV
 * eviction. Use as the `coldLookup` of an ingest credential resolver.
 */
export function makeEndpointTokenColdLookup(authn: Sql) {
  return async function coldLookup(tokenHash: Buffer): Promise<ResolvedPrincipal | null> {
    // `deleted_at is null` (ADR-0076) is the DURABLE stop for endpoints.delete: a soft-deleted
    // endpoint's token resolves to no row -> the ingest path 404s. Without it, the explicit KV
    // eviction would be undone by the very next cold miss re-caching the still-present row; with it,
    // the system also SELF-HEALS within the KV TTL if an eviction is ever missed. (webhook_authn was
    // granted select(deleted_at) in migration 0021 so this column read is permitted.)
    const rows = await authn<EndpointResolveRow[]>`
      select id, org_id, ingest_token_hash, paused
      from endpoints
      where ingest_token_hash = ${tokenHash} and deleted_at is null`;
    const row = rows[0];
    if (!row) return null;
    if (!credentialHashEquals(Buffer.from(row.ingest_token_hash), tokenHash)) return null;
    // Ingest tokens are audience-less (a write-only path token, not a bearer api key) and
    // carry no scopes; the ingest path's authorization is "owns this endpoint", not a scope.
    return { orgId: row.org_id, endpointId: row.id, scopes: [], paused: row.paused };
  };
}
