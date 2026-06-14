// The cache seam for the opaque-credential -> tenant resolver. Abstracted behind a
// tiny interface so the resolver is unit-testable with an in-memory mock and so the
// production binding (Cloudflare Workers KV) is injected at the edge — this Node-only
// package never imports Workers types.
//
// Why a cache at all, and why THIS shape: the cold path (a minimal-privilege Postgres
// lookup as webhook_authn) is a real round-trip we don't want on every authenticated
// request. KV is the hot path. Crucially, KV is the ONLY cache in the authn path:
// the cold lookup deliberately runs through a CACHE-DISABLED Hyperdrive binding
// (HYPERDRIVE_TENANT-style), never HYPERDRIVE_CACHED, because Hyperdrive's query cache
// can't be invalidated on revocation. KV can: revoke deletes the KV entry, so a
// revoked credential stops resolving on the very next request.

/** What a resolved credential maps to. Kept generic so ingest tokens reuse it. */
export interface ResolvedPrincipal {
  readonly orgId: string;
  /** Capability scopes for an api key; empty for a credential that carries none. */
  readonly scopes: readonly string[];
  /**
   * Optional opaque endpoint/resource id the credential is bound to. Unused by api
   * keys (org-scoped); the ingest-token resolver populates it so the SAME
   * cache + resolver serve `token -> {endpoint_id, org_id}` without a fork.
   */
  readonly endpointId?: string;
  /**
   * The resource the credential is bound to (RFC 8707 audience). verifyBearer rejects a
   * credential whose audience != the resource it's presented at. Optional on the cache
   * type so the ingest resolver (audience-less) reuses the shape; the api-key path
   * always sets it.
   */
  readonly audience?: string;
}

/**
 * The minimal cache contract the resolver needs. A subset of Cloudflare KV
 * (get/put/delete over string keys/values) so a Workers KVNamespace satisfies it
 * directly and a Map-backed mock satisfies it in tests. Values are JSON strings of a
 * ResolvedPrincipal; never the plaintext credential (keys are the hash hex).
 */
export interface CredentialCache {
  get(key: string): Promise<string | null>;
  /** ttlSeconds bounds staleness as a backstop; revocation invalidates explicitly. */
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Default cache TTL: a safety bound on staleness, NOT the primary invalidation path. */
export const CREDENTIAL_CACHE_TTL_SECONDS = 300;

/** A simple in-memory CredentialCache for tests (NOT for production — no eviction). */
export class InMemoryCredentialCache implements CredentialCache {
  private readonly store = new Map<string, string>();
  /** Test introspection: how many times get() was called (hot-path hit accounting). */
  public gets = 0;

  async get(key: string): Promise<string | null> {
    this.gets += 1;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
