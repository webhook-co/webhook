import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  createCredentialHasher,
  credentialCacheKey,
  CREDENTIAL_PEPPER_MIN_BYTES,
} from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver } from "../src/credential-resolver";
import {
  createEndpoint,
  getEndpointIngestTokenHash,
  makeEndpointTokenColdLookup,
} from "../src/endpoints";
import { createIngestResolver } from "../src/ingest-resolver";
import { createOrg } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The ingest-token resolver (hot KV + cold webhook_authn lookup), exercised against a REAL
// Postgres. The factory composes the SAME createCredentialResolver the api-key path uses
// with the endpoint cold lookup -- so the hot-hit, cold-miss, negatives-not-cached, and
// invalidation-forces-a-cold-miss invariants must all hold for ingest tokens too.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — create org/endpoint
let authn: Sql; // webhook_authn — the cold endpoint lookup binding
let orgId: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(pg.urlFor({ role: DB_ROLES.authn }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await pg?.stop();
});

describe("createIngestResolver", () => {
  it("resolves a presented token to its org+endpoint (+paused) via the cache", async () => {
    const ep = await createEndpoint(app, { orgId, name: "resolve-me" }, hasher);
    const cache = new InMemoryCredentialCache();
    const resolver = createIngestResolver({ hasher, cache, authn });

    const principal = await resolver.resolve(ep.plaintext);
    expect(principal?.orgId).toBe(orgId);
    expect(principal?.endpointId).toBe(ep.id);
    expect(principal?.paused).toBe(false);
    expect(cache.gets).toBeGreaterThan(0); // went through the hot-path cache seam
  });

  it("an unknown token resolves to null", async () => {
    const resolver = createIngestResolver({ hasher, cache: new InMemoryCredentialCache(), authn });
    expect(await resolver.resolve(`whep_${randomUUID()}`)).toBeNull();
  });

  it("invalidate forces a cold re-resolve that sees the new paused state", async () => {
    const ep = await createEndpoint(app, { orgId, name: "pause-then-invalidate" }, hasher);
    const cache = new InMemoryCredentialCache();
    const resolver = createIngestResolver({ hasher, cache, authn });

    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(false); // warms the cache (paused=false)

    await withTenant(app, orgId, async (tx) => {
      await tx`update endpoints set paused = true where id = ${ep.id}`;
    });
    // Without invalidation the stale cache entry still says paused=false...
    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(false);
    // ...invalidation (on pause/rotate/delete) forces the cold path, which sees paused=true.
    await resolver.invalidate(ep.plaintext);
    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(true);
  });
});

describe("hot path vs cold path accounting", () => {
  it("a hot hit avoids a second cold lookup; a negative is not cached", async () => {
    const ep = await createEndpoint(app, { orgId, name: "accounting" }, hasher);
    const cache = new InMemoryCredentialCache();
    let coldCalls = 0;
    const baseCold = makeEndpointTokenColdLookup(authn);
    const resolver = createCredentialResolver({
      hasher,
      cache,
      coldLookup: async (h) => {
        coldCalls += 1;
        return baseCold(h);
      },
    });

    await resolver.resolve(ep.plaintext); // cold (miss -> populate)
    await resolver.resolve(ep.plaintext); // hot (hit)
    expect(coldCalls).toBe(1);

    // Negatives are never cached: an unknown token takes the cold path every time.
    await resolver.resolve(`whep_${randomUUID()}`);
    await resolver.resolve(`whep_${randomUUID()}`);
    expect(coldCalls).toBe(3);
  });
});

describe("getEndpointIngestTokenHash (the cross-surface invalidation seam, ADR-0015)", () => {
  it("returns the hash whose cache key is EXACTLY where the resolver cached the principal", async () => {
    const ep = await createEndpoint(app, { orgId, name: "seam-key" }, hasher);
    const cache = new InMemoryCredentialCache();
    const resolver = createIngestResolver({ hasher, cache, authn });
    await resolver.resolve(ep.plaintext); // warm the cache (writes credentialCacheKey(<matched hash>))

    // A control-plane mutator holds the endpoint id, NOT the path-token plaintext. The stored token
    // hash -> credentialCacheKey() must land on the very entry the resolver wrote.
    const hash = await getEndpointIngestTokenHash(app, orgId, ep.id);
    expect(hash).not.toBeNull();
    expect(await cache.get(credentialCacheKey(hash!))).not.toBeNull();

    // invalidateHash(thatHash) evicts that exact entry.
    await resolver.invalidateHash(hash!);
    expect(await cache.get(credentialCacheKey(hash!))).toBeNull();
  });

  it("lets a secret mutation evict an endpoint's cached principal using only its id (no plaintext)", async () => {
    const ep = await createEndpoint(app, { orgId, name: "seam-evict" }, hasher);
    const cache = new InMemoryCredentialCache();
    const resolver = createIngestResolver({ hasher, cache, authn });
    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(false); // warm (paused=false)

    await withTenant(app, orgId, async (tx) => {
      await tx`update endpoints set paused = true where id = ${ep.id}`;
    });
    // Stale cache still says paused=false (stands in for a stale sealedSecrets snapshot)...
    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(false);
    // ...evict via the id-derived hash (exactly what a provider-secret add/revoke would do).
    const hash = await getEndpointIngestTokenHash(app, orgId, ep.id);
    await resolver.invalidateHash(hash!);
    expect((await resolver.resolve(ep.plaintext))?.paused).toBe(true);
  });

  it("is org-scoped under RLS and null for an unknown endpoint id", async () => {
    const ep = await createEndpoint(app, { orgId, name: "seam-rls" }, hasher);
    const otherOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Other" })).id;
    // Another org's tenant context cannot read this endpoint's token hash (RLS).
    expect(await getEndpointIngestTokenHash(app, otherOrg, ep.id)).toBeNull();
    // An unknown id under the right org is also null.
    expect(await getEndpointIngestTokenHash(app, orgId, randomUUID())).toBeNull();
  });
});
