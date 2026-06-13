// API-key lifecycle + the authn cold-path lookup (WS-D1b, §0.8, ADR-0008 Option B).
//
// TWO POOLS, STATED HONESTLY (S1) — this is NOT a "switch role" trick:
//   * webhook_app  owns create / list / revoke. These are ordinary tenant DML under
//     RLS, run inside withTenant(app, orgId, ...) so app.current_org pins the org.
//   * webhook_authn owns ONLY the verify cold path: a global-by-hash SELECT of the five
//     granted columns. webhook_authn deliberately CANNOT `SET ROLE webhook_app` (no role
//     membership) — granting that membership would defeat least-privilege. So a verified
//     request that then does per-tenant work uses TWO connections: the tiny authn pool to
//     discover {org_id, scopes} from the key, then the normal webhook_app pool with the
//     tenant context pinned to THAT org. Two round-trips per authenticated request; fine
//     OFF the ingest hot path (the hot path uses the KV cache, see credential-resolver).
//
// CACHING (S1 binding decision): the authn cold lookup is sensitive (a credential-hash ->
// org map) and MUST run through the CACHE-DISABLED Hyperdrive binding (HYPERDRIVE_TENANT
// style), NEVER HYPERDRIVE_CACHED — Hyperdrive's query cache can't be invalidated on
// revocation. The KV layer (credential-resolver) is the only authn cache, because KV
// CAN be invalidated on revoke. The caller wires the authn `Sql` to the uncached binding.

import { randomUUID } from "node:crypto";

import { withTenant, type Sql } from "./client";
import { credentialHashEquals, mintCredential, type CredentialHasher } from "./credential";
import type { ResolvedPrincipal } from "./credential-cache";

/** Default display prefix for api keys (the non-secret handle). */
export const API_KEY_PREFIX = "whk";

export interface CreateApiKeyInput {
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date | null;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly start: string;
  readonly expiresAt: Date | null;
  /** The plaintext key — returned ONCE, never persisted. Surface it to the user now. */
  readonly plaintext: string;
}

/** A row in a key listing: display metadata ONLY — never key_hash or plaintext. */
export interface ApiKeyListItem {
  readonly id: string;
  readonly name: string;
  readonly start: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Create an org-scoped api key. Mints a >=256-bit CSPRNG secret, stores ONLY its keyed
 * HMAC-SHA256 hash (peppered, see credential.ts) plus a non-secret display `start`, and
 * returns the plaintext exactly once. Runs as webhook_app under the org's RLS context. The
 * `hasher` carries the pepper (injected from a secret, never a literal). The edge generates
 * the uuidv7 id (no DB default) — randomUUID() is a stand-in until the shared uuidv7 mint
 * is wired; both are edge-generated uuids, so the storage contract is unchanged.
 */
export async function createApiKey(
  app: Sql,
  input: CreateApiKeyInput,
  hasher: CredentialHasher,
): Promise<CreatedApiKey> {
  const { plaintext, keyHash, start } = mintCredential(API_KEY_PREFIX, hasher);
  const id = randomUUID();
  const scopes = [...input.scopes];
  const expiresAt = input.expiresAt ?? null;

  await withTenant(app, input.orgId, async (tx) => {
    await tx`
      insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, expires_at)
      values (${id}, ${input.orgId}, ${keyHash}, ${API_KEY_PREFIX}, ${start},
              ${input.name}, ${tx.json(scopes)}, ${expiresAt})`;
  });

  return { id, orgId: input.orgId, name: input.name, scopes, start, expiresAt, plaintext };
}

/** List an org's api keys (newest first). Display metadata only — no hash, no plaintext. */
export async function listApiKeys(app: Sql, orgId: string): Promise<ApiKeyListItem[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<
      {
        id: string;
        name: string;
        start: string;
        scopes: unknown;
        created_at: Date;
        last_used_at: Date | null;
        expires_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`
      select id, name, start, scopes, created_at, last_used_at, expires_at, revoked_at
      from api_keys
      where org_id = ${orgId}
      order by created_at desc`;
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    start: r.start,
    scopes: toScopes(r.scopes),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

/**
 * Revoke an api key by id under the org's RLS context (stamps revoked_at). Returns true
 * if a row was revoked (RLS makes another org's key invisible -> false). The caller is
 * responsible for invalidating the credential cache (it holds the plaintext/hash); this
 * function only touches the row of record.
 */
export async function revokeApiKey(app: Sql, orgId: string, id: string): Promise<boolean> {
  const count = await withTenant(app, orgId, async (tx) => {
    const res = await tx`
      update api_keys
      set revoked_at = now(), updated_at = now()
      where id = ${id} and revoked_at is null`;
    return res.count;
  });
  return count > 0;
}

interface AuthnVerifyRow {
  org_id: string;
  scopes: unknown;
  expires_at: Date | null;
  revoked_at: Date | null;
  key_hash: Buffer;
}

/**
 * The webhook_authn COLD lookup (S1): resolve a key hash to its owning org + scopes, or
 * null. ORG-DISCOVERY-BY-HASH — there is no expected org before the lookup; the presented
 * key determines its org (that's why webhook_authn holds a FOR SELECT USING(true) policy
 * + a column-scoped grant). Honors revocation and expiry. Runs as webhook_authn through
 * the CACHE-DISABLED binding. Use this as the `coldLookup` of a credential resolver.
 *
 * `audience` is the resource these api keys are bound to (RFC 8707). The schema has no
 * audience column (api keys today are org credentials valid across the org's API/MCP
 * surfaces), so the binding is applied at resolution time: every resolved key carries
 * this single configured audience, and verifyBearer rejects it at any OTHER resource.
 * When real per-key audiences arrive (OAuth tokens), this is the seam that reads them.
 */
export function makeApiKeyColdLookup(authn: Sql, audience: string) {
  return async function coldLookup(keyHash: Buffer): Promise<ResolvedPrincipal | null> {
    const rows = await authn<AuthnVerifyRow[]>`
      select org_id, scopes, expires_at, revoked_at, key_hash
      from api_keys
      where key_hash = ${keyHash}`;
    const row = rows[0];
    if (!row) return null;
    // The lookup matched on equality, but never resolve a principal off an unverified
    // compare — re-check the stored hash against the queried hash in constant time
    // (defense-in-depth; this is exactly what credentialHashEquals exists for). Then guard
    // revocation and expiry explicitly so a stale/edge row can't resolve.
    if (!credentialHashEquals(Buffer.from(row.key_hash), keyHash)) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return null;
    return { orgId: row.org_id, scopes: toScopes(row.scopes), audience };
  };
}

/** Coerce the jsonb `scopes` column (postgres.js returns it parsed) to a string[]. */
function toScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}
