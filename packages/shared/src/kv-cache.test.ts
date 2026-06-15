import { describe, expect, it, vi } from "vitest";

import { kvCredentialCache } from "./kv-cache";

// Unit-tests the adapter against a fake KV (no Workers runtime needed): the get/put/delete wiring
// and the TTL -> expirationTtl mapping branch. A real-Miniflare-KV integration check lives in the
// engine's workers-pool suite (apps/engine/test/kv-cache.test.ts), which consumes this same module.

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function fakeKv() {
  const store = new Map<string, string>();
  const putCalls: PutCall[] = [];
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      putCalls.push({ key, value, options });
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { kv: kv as unknown as KVNamespace, putCalls };
}

describe("kvCredentialCache", () => {
  it("round-trips a value through put -> get and returns null for a miss", async () => {
    const { kv } = fakeKv();
    const cache = kvCredentialCache(kv);
    await cache.put("k1", `{"orgId":"o1","scopes":[]}`);
    expect(await cache.get("k1")).toBe(`{"orgId":"o1","scopes":[]}`);
    expect(await cache.get("absent")).toBeNull();
  });

  it("forwards a TTL as KV expirationTtl, and omits the options object when absent", async () => {
    const { kv, putCalls } = fakeKv();
    const cache = kvCredentialCache(kv);
    await cache.put("with-ttl", "v", 300);
    await cache.put("no-ttl", "v");
    expect(putCalls[0].options).toEqual({ expirationTtl: 300 });
    expect(putCalls[1].options).toBeUndefined();
  });

  it("delete evicts the entry (invalidation on revoke/pause/rotate)", async () => {
    const { kv } = fakeKv();
    const cache = kvCredentialCache(kv);
    await cache.put("k-evict", "v");
    await cache.delete("k-evict");
    expect(await cache.get("k-evict")).toBeNull();
  });
});
