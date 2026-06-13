// The ONE opaque-credential -> tenant resolver (S3). Both api keys (today) and ingest
// tokens (phase 1) have the identical shape: a presented plaintext credential whose
// minimal-privilege lookup role (webhook_authn / webhook_ingest) cannot resolve the
// owning org through ordinary table grants, so resolution needs a narrow, column-scoped
// cold path plus a hot cache. Implementing this once means the ingest resolver REUSES
// this exact module rather than forking a second copy.
//
// Shape:
//   1. hash the plaintext (never cache/log the plaintext),
//   2. HOT: look the hash up in the CredentialCache (KV at the edge); on a hit, done,
//   3. COLD (miss): run the caller-supplied minimal-privilege lookup (a webhook_authn
//      SELECT through a CACHE-DISABLED binding); on a resolved principal, populate KV,
//   4. revocation calls `invalidate(plaintext)` which DELETES the KV entry, so the next
//      request takes the cold path and sees the revoked/expired state.
//
// The cold path returns null for "no such credential / revoked / expired" — a null is
// NOT cached (caching negatives would let a just-created key 404 for the TTL window, and
// would let an attacker pin a negative). Only positive resolutions are cached.

import { credentialCacheKey, hashCredential } from "./credential";
import {
  CREDENTIAL_CACHE_TTL_SECONDS,
  type CredentialCache,
  type ResolvedPrincipal,
} from "./credential-cache";

/** The cold path: resolve a credential hash to a principal, or null if it can't. */
export type ColdLookup = (keyHash: Buffer) => Promise<ResolvedPrincipal | null>;

export interface CredentialResolver {
  /** Resolve a presented plaintext to its principal, or null. Hot path first. */
  resolve(plaintext: string): Promise<ResolvedPrincipal | null>;
  /** Invalidate a credential's cache entry (call on revoke/expiry/rotation). */
  invalidate(plaintext: string): Promise<void>;
  /** Invalidate by raw hash (when the plaintext isn't in hand, e.g. admin revoke). */
  invalidateHash(keyHash: Buffer): Promise<void>;
}

export interface CredentialResolverOptions {
  readonly cache: CredentialCache;
  readonly coldLookup: ColdLookup;
  /** Cache TTL backstop in seconds. Revocation is the primary invalidation path. */
  readonly ttlSeconds?: number;
}

function isResolvedPrincipal(value: unknown): value is ResolvedPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.orgId === "string" && Array.isArray(v.scopes);
}

/**
 * Build a resolver over a cache + cold path. The same factory serves api keys and ingest
 * tokens — only the `coldLookup` differs (which table, which minimal-privilege role).
 */
export function createCredentialResolver(opts: CredentialResolverOptions): CredentialResolver {
  const ttl = opts.ttlSeconds ?? CREDENTIAL_CACHE_TTL_SECONDS;

  async function resolve(plaintext: string): Promise<ResolvedPrincipal | null> {
    const keyHash = hashCredential(plaintext);
    const cacheKey = credentialCacheKey(keyHash);

    const cached = await opts.cache.get(cacheKey);
    if (cached !== null) {
      const parsed: unknown = JSON.parse(cached);
      // A malformed cache entry is treated as a miss (fail closed to the cold path),
      // never trusted — so a poisoned/garbled value can't forge a principal.
      if (isResolvedPrincipal(parsed)) return parsed;
    }

    const resolved = await opts.coldLookup(keyHash);
    if (resolved === null) return null; // negatives are NOT cached (see header).

    await opts.cache.put(cacheKey, JSON.stringify(resolved), ttl);
    return resolved;
  }

  async function invalidateHash(keyHash: Buffer): Promise<void> {
    await opts.cache.delete(credentialCacheKey(keyHash));
  }

  async function invalidate(plaintext: string): Promise<void> {
    await invalidateHash(hashCredential(plaintext));
  }

  return { resolve, invalidate, invalidateHash };
}
