// Single-sourced api-key auth wiring (P1, ADR-0010). api. / engine(/listen) / mcp. each validate api
// keys through the IDENTICAL resolver triple — a KV-cached credential resolver over the webhook_authn
// cold lookup, audience-bound to the surface's RFC 8707 resource, behind verifyBearer. This factory IS
// that triple, sourced once so the surfaces can't drift; the surface audiences live here too (the value
// the cold lookup and the resolver stamp must agree on). Per ADR-0010 r5/r7, a minted `whk_` key
// validates through THIS seam — there is no second key store.

import { API_KEY_PREFIX, makeApiKeyColdLookup } from "./api-keys";
import { type Sql } from "./client";
import { type CredentialHasher } from "./credential";
import { type CredentialCache } from "./credential-cache";
import { createCredentialResolver } from "./credential-resolver";
import { verifyKeyChecksum } from "./key-checksum";
import { makeVerifyBearer } from "./verify-bearer";

/** Canonical RFC 8707 audience for api.webhook.co (the api REST surface + the engine /listen tunnel). */
export const API_RESOURCE = "https://api.webhook.co";
/** Canonical RFC 8707 audience for mcp.webhook.co. */
export const MCP_RESOURCE = "https://mcp.webhook.co";

export interface ApiKeyAuthDepsOptions {
  /** The peppered credential hasher (decoded from a Worker secret; never a literal). */
  readonly hasher: CredentialHasher;
  /** The webhook_authn `Sql` — the CACHE-DISABLED Hyperdrive binding (see makeApiKeyColdLookup). */
  readonly authn: Sql;
  /** The shared KV_AUTHZ credential cache (invalidated on revoke). */
  readonly cache: CredentialCache;
  /** This surface's RFC 8707 resource (API_RESOURCE | MCP_RESOURCE); the audience keys bind to here. */
  readonly resource: string;
}

/** The api-key auth deps a bearer surface needs: a verifyBearer bound to `resource`. */
export interface ApiKeyAuthDeps {
  readonly verifyBearer: ReturnType<typeof makeVerifyBearer>;
  readonly resource: string;
}

/**
 * Build one surface's api-key auth deps: a KV-cached credential resolver over the webhook_authn cold
 * lookup. The cold lookup returns a key's INTRINSIC per-key audience (from `api_keys.audience`) or
 * undefined for a legacy/org-wide key; `resource` drives ONLY the resolver's conditional audience
 * stamp (A0b) — applied to the undefined case, left off any per-key audience. So the shared KV_AUTHZ
 * cache stays audience-agnostic for legacy keys (one entry per key, revoke-complete; each surface
 * stamps its own) while per-key (OAuth-minted) keys stay confined to their bound surface. Returns
 * verifyBearer + resource; callers add any surface-only extras (e.g. the PRM url). Replaces the
 * identical inline wiring in apps/api, apps/engine, apps/mcp.
 */
export function makeApiKeyAuthDeps(opts: ApiKeyAuthDepsOptions): ApiKeyAuthDeps {
  const resolver = createCredentialResolver({
    hasher: opts.hasher,
    cache: opts.cache,
    // The cold lookup returns a key's intrinsic per-key audience (or undefined for legacy keys);
    // `resource` is the surface audience the resolver conditionally stamps on the undefined case (A0b).
    coldLookup: makeApiKeyColdLookup(opts.authn),
    resource: opts.resource,
    // ADR-0073: reject a malformed/typo'd/old-format whk_ key at the edge (before hash/cache/DB).
    // This is INTENTIONALLY only on the api-key path — the ingest resolver (whep_ tokens, which carry
    // no checksum) omits it. Forgetting it elsewhere only forfeits cheap DoS-shedding, never auth
    // (the by-hash lookup is the real auth); the checksum is not a security control.
    precheck: (plaintext) => verifyKeyChecksum(API_KEY_PREFIX, plaintext),
  });
  return { verifyBearer: makeVerifyBearer(resolver), resource: opts.resource };
}
