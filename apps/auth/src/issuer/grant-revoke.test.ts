import { describe, expect, it, vi } from "vitest";

import { revokeGrantAndEvict, type GrantRevokeCascadeDeps } from "./grant-revoke";

// The cascade's ORDERING is the security property, so it is asserted, not assumed.
//
// The DB commit is authoritative but INVISIBLE to api./mcp./engine, which resolve a bearer from the shared
// KV principal cache. Until the cache entry is gone, a revoked key keeps authenticating for the cache TTL.
// The refresh-handle sweep, by contrast, is pure tidying — the consume gate already refuses a revoked grant.
// So a failure of the sweep must never be able to skip the eviction.

const HASH_A = new Uint8Array([1, 2, 3]);
const HASH_B = new Uint8Array([4, 5, 6]);

function deps(over: Partial<GrantRevokeCascadeDeps> = {}): GrantRevokeCascadeDeps {
  return {
    revokeGrant: vi.fn(async () => ({ revokedKeyHashes: [HASH_A, HASH_B] })),
    revokeRefreshTokens: vi.fn(async () => {}),
    cache: { delete: vi.fn(async () => {}) },
    cacheKey: (h) => `k:${[...h].join("-")}`,
    log: vi.fn(),
    ...over,
  };
}

const evictions = (d: GrantRevokeCascadeDeps) =>
  (d.cache.delete as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe("revokeGrantAndEvict", () => {
  it("commits the revoke, then evicts every cascaded key from the principal cache", async () => {
    const d = deps();
    await revokeGrantAndEvict(d);
    expect(d.revokeGrant).toHaveBeenCalled();
    expect(evictions(d)).toEqual(["k:1-2-3", "k:4-5-6"]);
    expect(d.revokeRefreshTokens).toHaveBeenCalled();
  });

  // The finding this module exists to fix: eviction was sequenced AFTER the sweep, so one transient fault on
  // the *tidying* write left a revoked credential live at the edge for the whole cache TTL.
  it("STILL evicts when the refresh-handle sweep throws (the sweep cannot skip the eviction)", async () => {
    const d = deps({
      revokeRefreshTokens: vi.fn(async () => {
        throw new Error("transient postgres fault");
      }),
    });
    await expect(revokeGrantAndEvict(d)).resolves.toBeUndefined();
    expect(evictions(d)).toEqual(["k:1-2-3", "k:4-5-6"]);
  });

  it("evicts BEFORE sweeping — the eviction is what actually stops the credential", async () => {
    const order: string[] = [];
    const d = deps({
      cache: {
        delete: vi.fn(async () => {
          order.push("evict");
        }),
      },
      revokeRefreshTokens: vi.fn(async () => {
        order.push("sweep");
      }),
    });
    await revokeGrantAndEvict(d);
    expect(order.indexOf("evict")).toBeLessThan(order.indexOf("sweep"));
  });

  it("a KV fault is best-effort — it self-heals at the cache TTL and never fails the revoke", async () => {
    const d = deps({
      cache: {
        delete: vi.fn(async () => {
          throw new Error("kv unavailable");
        }),
      },
    });
    await expect(revokeGrantAndEvict(d)).resolves.toBeUndefined();
    expect(d.revokeRefreshTokens).toHaveBeenCalled();
  });

  // The DB commit is the one step that must NOT be swallowed: a revoke that didn't commit must not look
  // like it did, or the caller reports success while the credential is still live in Postgres.
  it("PROPAGATES a failure of the authoritative DB revoke", async () => {
    const d = deps({
      revokeGrant: vi.fn(async () => {
        throw new Error("revoke failed");
      }),
    });
    await expect(revokeGrantAndEvict(d)).rejects.toThrow(/revoke failed/);
    expect(d.cache.delete).not.toHaveBeenCalled();
  });
});
