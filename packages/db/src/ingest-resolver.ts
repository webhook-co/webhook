// The ingest-token resolver: the per-request seam the wbhk.my write path calls to turn a
// presented path token into {org, endpoint, paused}. It is the SAME createCredentialResolver
// the api-key verify path uses -- hot KV cache in front of a minimal-privilege cold lookup --
// composed with the endpoint cold lookup. Only the coldLookup differs (endpoints, as
// webhook_authn, vs api_keys). So the hot-hit / cold-miss / negatives-not-cached /
// invalidation-on-revoke invariants are inherited verbatim rather than re-implemented.
//
// Wiring at the edge: `cache` is the Workers KV binding (the only invalidatable cache;
// Hyperdrive's query cache cannot be), and `authn` is the webhook_authn Sql on the
// CACHE-DISABLED Hyperdrive binding. The hot path is one KV read; the cold path (cache miss)
// is one webhook_authn SELECT-by-hash. The resolved principal carries `paused` so the ingest
// guard reads pause state from that one KV read, never a synchronous DB count.

import { type Sql } from "./client";
import { type CredentialHasher } from "./credential";
import { type CredentialCache } from "./credential-cache";
import {
  createCredentialResolver,
  type ColdLookup,
  type CredentialResolver,
} from "./credential-resolver";
import { makeEndpointTokenColdLookup } from "./endpoints";
import { getEndpointProviderSecrets, toCachedSealedSecret } from "./provider-secrets";

export interface IngestResolverOptions {
  /** Keyed hasher (HMAC + pepper) -- the same primitive that minted the ingest token. */
  readonly hasher: CredentialHasher;
  /** Hot cache (Workers KV at the edge; invalidatable on pause/rotate/delete). */
  readonly cache: CredentialCache;
  /** webhook_authn Sql on the CACHE-DISABLED binding, for the cold endpoint lookup. */
  readonly authn: Sql;
  /** Cache TTL backstop in seconds. Invalidation is the primary freshness path. */
  readonly ttlSeconds?: number;
}

/**
 * Build the ingest-token resolver. Returns the standard `CredentialResolver` -- `resolve`
 * (hot KV -> cold webhook_authn lookup) returns the endpoint principal or null (null => the
 * write path 404s an unknown token), and `invalidate` evicts on pause/rotate/delete.
 */
export function createIngestResolver(opts: IngestResolverOptions): CredentialResolver {
  const resolveEndpoint = makeEndpointTokenColdLookup(opts.authn);
  // Compose the cold path: resolve the endpoint, then (same webhook_authn connection, same cache
  // miss) fetch its sealed provider secrets and carry them base64-encoded on the principal. The
  // resolver caches the whole principal in KV, so a cache HIT serves {endpoint + verify secrets}
  // from one KV read -- no per-event DB query for secrets. Both reads stay on the cache-disabled
  // binding.
  //
  // STALENESS / REVOCATION LAG (must wire explicit invalidation): the cached principal carries a
  // snapshot of the endpoint's secrets. A secret ADDED after caching just isn't honored until the
  // entry refreshes (events verify as unverified meanwhile -- benign, capture is the floor). A
  // REVOKED secret is the security-relevant case: a principal cached BEFORE the revoke keeps the now-
  // revoked sealed secret, so verify would keep accepting signatures made with it until the KV entry
  // expires (TTL backstop) or is invalidated. Until add/revoke is wired to invalidate this resolver's
  // KV entry (follow-up), the TTL bounds the revocation window -- keep that TTL tight for the ingest
  // resolver and treat prompt secret revocation as requiring explicit invalidation.
  const coldLookup: ColdLookup = async (tokenHash) => {
    const principal = await resolveEndpoint(tokenHash);
    if (principal === null || principal.endpointId === undefined) return principal;
    const sealed = await getEndpointProviderSecrets(opts.authn, principal.endpointId);
    return { ...principal, sealedSecrets: sealed.map(toCachedSealedSecret) };
  };
  return createCredentialResolver({
    hasher: opts.hasher,
    cache: opts.cache,
    coldLookup,
    ttlSeconds: opts.ttlSeconds,
  });
}
