// Single-sourced api-key auth wiring (P1, ADR-0010). api. / engine(/listen) / mcp. each validate api
// keys through the IDENTICAL resolver triple — a KV-cached credential resolver over the webhook_authn
// cold lookup, audience-bound to the surface's RFC 8707 resource, behind verifyBearer. This factory IS
// that triple, sourced once so the surfaces can't drift; the surface audiences live here too (the value
// the cold lookup and the resolver stamp must agree on). Per ADR-0010 r5/r7, a minted `whk_` key
// validates through THIS seam — there is no second key store.

import { makeApiKeyColdLookup } from "./api-keys";
import { type Sql } from "./client";
import { type CredentialHasher } from "./credential";
import { type CredentialCache } from "./credential-cache";
import { createCredentialResolver } from "./credential-resolver";
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
 * lookup, with `resource` driving BOTH the cold lookup's audience binding and the resolver's audience
 * stamp — so the shared KV_AUTHZ cache stays audience-agnostic (one entry per key, revoke-complete)
 * while each surface still sees its own audience. Returns verifyBearer + resource; callers add any
 * surface-only extras (e.g. the PRM url). Replaces the identical inline wiring in apps/api, apps/engine,
 * apps/mcp.
 */
export function makeApiKeyAuthDeps(opts: ApiKeyAuthDepsOptions): ApiKeyAuthDeps {
  const resolver = createCredentialResolver({
    hasher: opts.hasher,
    cache: opts.cache,
    coldLookup: makeApiKeyColdLookup(opts.authn, opts.resource),
    resource: opts.resource,
  });
  return { verifyBearer: makeVerifyBearer(resolver), resource: opts.resource };
}
