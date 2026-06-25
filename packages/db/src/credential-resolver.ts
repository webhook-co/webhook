// The ONE opaque-credential -> tenant resolver. Both api keys (today) and ingest
// tokens (later) have the identical shape: a presented plaintext credential whose
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

import { credentialCacheKey, type CredentialHasher } from "./credential";
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
  /** Keyed hasher (HMAC + pepper). Supplies the rotation-aware candidate hashes. */
  readonly hasher: CredentialHasher;
  readonly cache: CredentialCache;
  readonly coldLookup: ColdLookup;
  /** Cache TTL backstop in seconds. Revocation is the primary invalidation path. */
  readonly ttlSeconds?: number;
  /**
   * The presenting surface's RFC-8707 resource (audience), for audience-bound surfaces — the api-key
   * path at api / mcp / the listen tunnel. When set, the resolver stamps THIS resource as the
   * resolved principal's `audience`, on BOTH the cache-hit and cold paths.
   *
   * Why: KV_AUTHZ is a SINGLE namespace shared across api + mcp + engine, the cache key is the bare
   * credential hash, and api keys are org credentials valid across the org's surfaces (no per-key
   * audience). Without this, a cache entry populated by one surface (e.g. api, stamping
   * `audience=https://api.webhook.co`) is served to another (mcp), whose `verifyBearer` then rejects
   * it on an audience mismatch. Stamping the presenting surface's resource here makes the shared
   * cache audience-agnostic — one entry per key, so revoke/invalidate stays complete — while each
   * surface still sees its own audience. Omit for the ingest path (endpoint tokens carry no audience).
   *
   * The stamp is CONDITIONAL (A0b): it applies only to a principal with no intrinsic audience (a
   * legacy/org-wide key). A per-key audience read from `api_keys.audience` by makeApiKeyColdLookup is
   * honored as-is — never widened to the presenting surface — so per-key (OAuth-minted) keys stay
   * confined to their bound surface while legacy keys remain valid across the org's surfaces.
   */
  readonly resource?: string;
  /**
   * OPT-IN structural precheck (ADR-0073). When supplied, it runs FIRST in `resolve()` — before
   * hashing, the cache, and the cold lookup — and a `false` result returns `null` immediately
   * (the same shape as an unknown credential: no oracle, no DB/KV work). The api-key path injects
   * `verifyKeyChecksum` here (via auth-deps) to reject malformed/typo'd/old-format `whk_` keys at
   * the edge. It is OPT-IN on purpose: this same factory also serves `whep_` ingest tokens (which
   * carry no checksum), so an unconditional guard would wrongly reject them — the ingest resolver
   * simply omits it. NOT a security control: the checksum is public error-detection (see
   * key-checksum.ts); its value here is cheap DoS-shedding + a self-validating format.
   */
  readonly precheck?: (plaintext: string) => boolean;
}

function isResolvedPrincipal(value: unknown): value is ResolvedPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // Validate the FULL shape, not just the top-level field kinds — a poisoned/garbled
  // entry whose scopes array holds non-strings (or whose optional fields are the wrong
  // type) must NOT pass as a principal. Anything that fails falls through to the cold path.
  if (typeof v.orgId !== "string" || v.orgId === "") return false;
  if (!Array.isArray(v.scopes) || !v.scopes.every((s) => typeof s === "string")) return false;
  if (v.endpointId !== undefined && typeof v.endpointId !== "string") return false;
  // paused is a security-relevant gate signal for the ingest path — a non-boolean (poisoned
  // or legacy) entry must fall through to the cold path, never resolve with a truthy garble.
  if (v.paused !== undefined && typeof v.paused !== "boolean") return false;
  if (v.audience !== undefined && typeof v.audience !== "string") return false;
  // sealedSecrets feeds the verify path. A poisoned/partial entry (wrong shape, missing base64
  // field) must fall through to the cold path, never resolve a half-formed secret list that would
  // later throw mid-unseal. Validate every element fully.
  if (v.sealedSecrets !== undefined) {
    if (!Array.isArray(v.sealedSecrets) || !v.sealedSecrets.every(isCachedSealedSecret))
      return false;
  }
  return true;
}

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isCachedSealedSecret(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const str = (x: unknown): boolean => typeof x === "string" && x !== "";
  // The byte fields must be non-empty STANDARD base64 — not merely non-empty strings. Node/workerd
  // base64 decoders are lenient (they drop junk silently), so a non-base64 value would otherwise pass
  // here and only fail later at GCM decrypt; reject it at the cache boundary so the guard truly fails
  // closed (the stated intent) rather than deferring a garbled secret into the verify path.
  const b64 = (x: unknown): boolean => typeof x === "string" && STANDARD_BASE64.test(x);
  if (!str(s.id) || !str(s.provider) || !str(s.kekRef)) return false;
  if (!b64(s.ciphertextB64) || !b64(s.nonceB64) || !b64(s.wrappedDekB64)) return false;
  if (typeof s.envelopeVersion !== "number") return false;
  const ctx = s.context as Record<string, unknown> | null | undefined;
  if (typeof ctx !== "object" || ctx === null) return false;
  return str(ctx.orgId) && str(ctx.endpointId) && str(ctx.keyId);
}

/**
 * Build a resolver over a cache + cold path. The same factory serves api keys and ingest
 * tokens — only the `coldLookup` differs (which table, which minimal-privilege role).
 */
export function createCredentialResolver(opts: CredentialResolverOptions): CredentialResolver {
  const ttl = opts.ttlSeconds ?? CREDENTIAL_CACHE_TTL_SECONDS;

  // Stamp the presenting surface's audience on a resolved principal ONLY when it carries none — a
  // legacy/org-wide api key (the cold lookup returns no audience) or an ingest token. A credential
  // that resolved WITH its own intrinsic audience (a per-key OAuth-minted key, read from
  // api_keys.audience by makeApiKeyColdLookup) is left intact — never widened to the presenting
  // surface. This keeps the shared bare-hash cache audience-AGNOSTIC for legacy keys (stored
  // audience-less, so each surface stamps its own — the cross-surface 401 guard) while CONFINING
  // per-key-audience keys to their bound surface. No-op when not audience-bound (ingest, no resource).
  const stampAudience = (p: ResolvedPrincipal): ResolvedPrincipal =>
    p.audience !== undefined || opts.resource === undefined ? p : { ...p, audience: opts.resource };

  async function resolve(plaintext: string): Promise<ResolvedPrincipal | null> {
    // EDGE GUARD (ADR-0073, opt-in): reject a structurally-invalid credential before any
    // hashing / cache / DB work. A failed precheck returns null — byte-identical to an unknown
    // credential, so it is no auth oracle (it distinguishes only well-formed-ness, which is
    // public; the timing fast-fail leaks zero secret bits — it is deliberately a cheap
    // DoS-shedding filter, NOT an authentication boundary). Omitted on the ingest path.
    if (opts.precheck !== undefined && !opts.precheck(plaintext)) return null;

    // Candidate hashes: current pepper first, then any previous peppers (rotation window).
    // The common single-pepper case is exactly one hash -> one cache get / one cold lookup,
    // identical to the un-peppered path; extra candidates only exist mid-rotation.
    const hashes = opts.hasher.candidates(plaintext);

    // HOT: try the cache for each candidate.
    for (const keyHash of hashes) {
      const cached = await opts.cache.get(credentialCacheKey(keyHash));
      if (cached !== null) {
        // A malformed cache entry is treated as a miss (fail closed to the cold path),
        // never trusted — so a poisoned/garbled value can't forge a principal. This covers
        // BOTH a value that is valid JSON of the wrong shape AND a value that is not JSON at
        // all (a truncated/partial KV write or an externally poisoned entry): JSON.parse
        // throws on the latter, so it is caught here and reduced to a miss rather than
        // surfacing as an unhandled 500 that would deny a valid credential for the TTL.
        let parsed: unknown;
        try {
          parsed = JSON.parse(cached);
        } catch {
          parsed = null;
        }
        if (isResolvedPrincipal(parsed)) return stampAudience(parsed);
      }
    }

    // COLD (miss): minimal-privilege lookup per candidate; cache the hash that matched.
    for (const keyHash of hashes) {
      const resolved = await opts.coldLookup(keyHash);
      if (resolved === null) continue; // negatives are NOT cached (see header).
      await opts.cache.put(credentialCacheKey(keyHash), JSON.stringify(resolved), ttl);
      return stampAudience(resolved);
    }
    return null;
  }

  async function invalidateHash(keyHash: Buffer): Promise<void> {
    await opts.cache.delete(credentialCacheKey(keyHash));
  }

  async function invalidate(plaintext: string): Promise<void> {
    // Clear every candidate's entry so a key minted under any accepted pepper is evicted.
    for (const keyHash of opts.hasher.candidates(plaintext)) {
      await invalidateHash(keyHash);
    }
  }

  return { resolve, invalidate, invalidateHash };
}
