import { describe, expect, it } from "vitest";

import { generateDekKey } from "../envelope";
import { OrgScopedDekCache } from "./lru";

const key = () => generateDekKey();

describe("OrgScopedDekCache (ADR-0007 isolate cache)", () => {
  it("returns a previously stored handle without re-loading (cache hit)", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 4 });
    let loads = 0;
    const loader = async () => {
      loads++;
      return key();
    };
    const a = await cache.getOrLoad("org_1", "wrap_a", loader);
    const b = await cache.getOrLoad("org_1", "wrap_a", loader);
    expect(loads).toBe(1);
    expect(b).toBe(a);
  });

  it("evicts the least-recently-used entry at the size bound", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 2 });
    let loads = 0;
    const loader = async () => {
      loads++;
      return key();
    };
    await cache.getOrLoad("org_1", "a", loader); // [a]
    await cache.getOrLoad("org_1", "b", loader); // [a,b]
    await cache.getOrLoad("org_1", "a", loader); // touch a -> [b,a]
    await cache.getOrLoad("org_1", "c", loader); // evict b -> [a,c]
    expect(loads).toBe(3);
    expect(cache.size).toBe(2);

    await cache.getOrLoad("org_1", "b", loader); // miss, b was evicted
    expect(loads).toBe(4);
  });

  it("scopes entries per org so one tenant's handle never serves another", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    const k1 = await cache.getOrLoad("org_1", "same_ref", key);
    const k2 = await cache.getOrLoad("org_2", "same_ref", key);
    expect(k1).not.toBe(k2);
    // Re-reading org_1 returns org_1's handle, not org_2's.
    expect(await cache.getOrLoad("org_1", "same_ref", key)).toBe(k1);
  });

  it("counts size across all orgs and evicts globally at the bound", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 2 });
    await cache.getOrLoad("org_1", "a", key);
    await cache.getOrLoad("org_2", "b", key);
    await cache.getOrLoad("org_3", "c", key); // evicts org_1/a
    expect(cache.size).toBe(2);
    let reloaded = false;
    await cache.getOrLoad("org_1", "a", async () => {
      reloaded = true;
      return key();
    });
    expect(reloaded).toBe(true);
  });

  it("BAA zero-cache hook bypasses the cache entirely (unwrap-per-use)", async () => {
    const cache = new OrgScopedDekCache({
      maxEntries: 8,
      isCacheDisabled: (orgId) => orgId === "org_baa",
    });
    let loads = 0;
    const loader = async () => {
      loads++;
      return key();
    };
    const a = await cache.getOrLoad("org_baa", "ref", loader);
    const b = await cache.getOrLoad("org_baa", "ref", loader);
    expect(loads).toBe(2); // never cached
    expect(a).not.toBe(b);
    expect(cache.size).toBe(0); // nothing stored for the BAA org

    // A non-BAA org in the same cache still caches normally.
    await cache.getOrLoad("org_free", "ref", loader);
    await cache.getOrLoad("org_free", "ref", loader);
    expect(loads).toBe(3);
  });

  it("drops a tenant's handles on invalidateOrg (e.g. key rotation)", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    const a = await cache.getOrLoad("org_1", "ref", key);
    await cache.getOrLoad("org_2", "ref", key);
    cache.invalidateOrg("org_1");
    expect(cache.size).toBe(1);
    const reloaded = await cache.getOrLoad("org_1", "ref", key);
    expect(reloaded).not.toBe(a);
  });

  it("clears everything on clear()", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    await cache.getOrLoad("org_1", "a", key);
    await cache.getOrLoad("org_2", "b", key);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("does not store a handle when the loader rejects", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    await expect(
      cache.getOrLoad("org_1", "ref", async () => {
        throw new Error("unwrap failed");
      }),
    ).rejects.toThrow(/unwrap failed/);
    expect(cache.size).toBe(0);
  });

  it("coalesces concurrent loads for the same key into one loader call", async () => {
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return key();
    };
    const [a, b] = await Promise.all([
      cache.getOrLoad("org_1", "ref", loader),
      cache.getOrLoad("org_1", "ref", loader),
    ]);
    expect(loads).toBe(1);
    expect(a).toBe(b);
  });

  it("rejects a non-positive maxEntries", () => {
    expect(() => new OrgScopedDekCache({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
