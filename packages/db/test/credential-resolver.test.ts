import { describe, expect, it } from "vitest";

import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { InMemoryCredentialCache } from "../src/credential-cache";
import { createCredentialResolver, type ColdLookup } from "../src/credential-resolver";

// Pure (no DB) coverage for the resolver's audience stamping — the fix for the cross-surface
// KV_AUTHZ bug: api + mcp + the engine tunnel share ONE cache namespace keyed by the bare
// credential hash, so a principal cached by one surface must NOT carry its audience into another.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xab) });
const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";

// A cold lookup whose principal carries a deliberately-"wrong" audience, so the assertions prove
// the RESOLVER overwrites it with its own `resource` rather than trusting the cold/cached audience.
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

describe("createCredentialResolver — audience stamping over a shared cache", () => {
  it("stamps the presenting surface's resource on the cold path (ignoring the cold-lookup's audience)", async () => {
    const r = createCredentialResolver({
      hasher,
      cache: new InMemoryCredentialCache(),
      coldLookup: coldReturning("https://stale.example").fn,
      resource: API,
    });
    expect((await r.resolve("whk_x"))?.audience).toBe(API);
  });

  it("a cache entry populated by one surface resolves with the OTHER surface's audience", async () => {
    const cache = new InMemoryCredentialCache(); // ONE shared cache, like KV_AUTHZ
    const api = createCredentialResolver({
      hasher,
      cache,
      coldLookup: coldReturning("ignored").fn,
      resource: API,
    });
    const mcp = createCredentialResolver({
      hasher,
      cache,
      coldLookup: coldReturning("ignored").fn,
      resource: MCP,
    });

    expect((await api.resolve("whk_shared"))?.audience).toBe(API); // cold → caches
    const viaMcp = await mcp.resolve("whk_shared"); // cache HIT (cross-surface)
    expect(viaMcp?.audience).toBe(MCP); // NOT the cached api audience — the bug fix
    expect(viaMcp?.orgId).toBe("org_1"); // identity fields are surface-independent
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
    const cold = coldReturning("ignored");
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
