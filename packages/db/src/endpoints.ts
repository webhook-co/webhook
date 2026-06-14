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

import { withTenant, type Sql } from "./client";
import { credentialHashEquals, mintCredential, type CredentialHasher } from "./credential";
import type { ResolvedPrincipal } from "./credential-cache";

/** Display + path prefix for ingest tokens (the wbhk.my/<token> path token). */
export const INGEST_TOKEN_PREFIX = "whep";

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
 * in constant time (defense-in-depth; that's what credentialHashEquals is for). Ingest tokens
 * have no revoke/expiry columns (unlike api keys); rotation/removal is a row delete + KV
 * invalidation. Use as the `coldLookup` of an ingest credential resolver.
 */
export function makeEndpointTokenColdLookup(authn: Sql) {
  return async function coldLookup(tokenHash: Buffer): Promise<ResolvedPrincipal | null> {
    const rows = await authn<EndpointResolveRow[]>`
      select id, org_id, ingest_token_hash, paused
      from endpoints
      where ingest_token_hash = ${tokenHash}`;
    const row = rows[0];
    if (!row) return null;
    if (!credentialHashEquals(Buffer.from(row.ingest_token_hash), tokenHash)) return null;
    // Ingest tokens are audience-less (a write-only path token, not a bearer api key) and
    // carry no scopes; the ingest path's authorization is "owns this endpoint", not a scope.
    return { orgId: row.org_id, endpointId: row.id, scopes: [], paused: row.paused };
  };
}
