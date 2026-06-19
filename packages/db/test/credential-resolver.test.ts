import { describe, expect, it } from "vitest";

import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver, type ColdLookup } from "../src/credential-resolver";

// Pure (no DB) coverage for the resolver's CONDITIONAL audience stamp (A0b) — the fix for the
// cross-surface KV_AUTHZ bug: api + mcp + the engine tunnel share ONE cache namespace keyed by the
// bare credential hash. A legacy/org-wide key carries no intrinsic audience, so each surface stamps
// its OWN audience (one shared entry, but the cross-surface 401 guard still holds). A per-key
// OAuth-minted key carries its own intrinsic audience (api_keys.audience) which the resolver HONORS —
// never widens to the presenting surface — so the key stays confined to its bound surface even
// through the shared cache. The cache stores the raw cold result (audience-agnostic); the stamp is
// applied on the way out of BOTH the cache-hit and the cold path.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xab) });
const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";

// A cold lookup returning a principal with an OPTIONAL intrinsic audience: `undefined` models a
// legacy/org-wide key (audience-less — the resolver stamps the presenting surface); a value models a
// per-key OAuth-minted audience (the resolver must HONOR it, never widen it to the surface).
function coldReturning(audience: string | undefined): { fn: ColdLookup; calls: () => number } {
  let calls = 0;
  const fn: ColdLookup = async () => {
    calls++;
    return {
      orgId: "org_1",
      scopes: ["events:read"],
      ...(audience !== undefined ? { audience } : {}),
    };
  };
  return { fn, calls: () => calls };
}

describe("createCredentialResolver — conditional audience stamp over a shared cache", () => {
  it("stamps the presenting surface's resource on a legacy key (no intrinsic audience)", async () => {
    const r = createCredentialResolver({
      hasher,
      cache: new InMemoryCredentialCache(),
      coldLookup: coldReturning(undefined).fn, // legacy/org-wide key — audience-less
      resource: API,
    });
    expect((await r.resolve("whk_x"))?.audience).toBe(API);
  });

  it("HONORS a per-key intrinsic audience — never widens it to the presenting surface", async () => {
    // A per-key OAuth-minted key bound to mcp, resolved through an API-surface resolver. The
    // intrinsic mcp audience must win so verifyBearer at api rejects it (the confinement guard).
    const r = createCredentialResolver({
      hasher,
      cache: new InMemoryCredentialCache(),
      coldLookup: coldReturning(MCP).fn, // intrinsic per-key audience = mcp
      resource: API, // presenting surface is api
    });
    expect((await r.resolve("whk_perkey"))?.audience).toBe(MCP);
  });

  it("a LEGACY key cached by one surface resolves with the OTHER surface's audience", async () => {
    const cache = new InMemoryCredentialCache(); // ONE shared cache, like KV_AUTHZ
    const api = createCredentialResolver({
      hasher,
      cache,
      coldLookup: coldReturning(undefined).fn,
      resource: API,
    });
    const mcp = createCredentialResolver({
      hasher,
      cache,
      coldLookup: coldReturning(undefined).fn,
      resource: MCP,
    });

    expect((await api.resolve("whk_shared"))?.audience).toBe(API); // cold → caches (audience-less)
    const viaMcp = await mcp.resolve("whk_shared"); // cache HIT (cross-surface)
    expect(viaMcp?.audience).toBe(MCP); // each surface stamps its own — the cross-surface 401 guard
    expect(viaMcp?.orgId).toBe("org_1"); // identity fields are surface-independent
  });

  it("a per-key-audience key stays CONFINED through the shared cache (a cache hit never widens it)", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = coldReturning(API); // intrinsic per-key audience = api
    const api = createCredentialResolver({ hasher, cache, coldLookup: cold.fn, resource: API });
    const mcp = createCredentialResolver({ hasher, cache, coldLookup: cold.fn, resource: MCP });

    expect((await api.resolve("whk_pk"))?.audience).toBe(API); // cold; cached WITH audience=api
    expect((await mcp.resolve("whk_pk"))?.audience).toBe(API); // cache hit; mcp does NOT widen it
    expect(cold.calls()).toBe(1); // one shared entry; the confinement survives the cache
  });

  it("omitting resource leaves the principal audience untouched (ingest path)", async () => {
    const r = createCredentialResolver({
      hasher,
      cache: new InMemoryCredentialCache(),
      coldLookup: coldReturning(undefined).fn,
    });
    // whep_ = an ingest endpoint token (the ingest resolver omits `resource`) — deliberately distinct
    // from the whk_ api-key plaintexts in the other cases, to model the ingest path this case names.
    expect((await r.resolve("whep_x"))?.audience).toBeUndefined();
  });

  it("shares one bare-hash entry across surfaces, so a single invalidate clears it everywhere", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = coldReturning(undefined); // legacy key
    const api = createCredentialResolver({ hasher, cache, coldLookup: cold.fn, resource: API });
    const mcp = createCredentialResolver({ hasher, cache, coldLookup: cold.fn, resource: MCP });

    await api.resolve("whk_r"); // cold (1)
    await mcp.resolve("whk_r"); // cache HIT — no second cold lookup
    expect(cold.calls()).toBe(1);

    await api.invalidate("whk_r"); // one bare-hash entry deleted
    await mcp.resolve("whk_r"); // cache MISS for mcp too → cold (2): invalidate was complete
    expect(cold.calls()).toBe(2);
  });
});
