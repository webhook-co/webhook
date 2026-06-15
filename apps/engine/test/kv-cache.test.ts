import { kvCredentialCache } from "@webhook-co/shared/kv-cache";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

// The KV-backed CredentialCache the ingest resolver's hot path uses. KV is the ONLY ingest cache
// (it can be invalidated on pause/rotate/delete; Hyperdrive's query cache can't). The adapter is
// shared by every bearer Worker (@webhook-co/shared/kv-cache); this exercises it against the
// engine's real Miniflare KV so the get/put/delete adapter matches the CredentialCache seam exactly.
const bindings = env as unknown as Env;

describe("kvCredentialCache", () => {
  it("round-trips a value through put -> get", async () => {
    const cache = kvCredentialCache(bindings.KV_CONFIG);
    await cache.put("k-roundtrip", `{"orgId":"o1","scopes":[]}`);
    expect(await cache.get("k-roundtrip")).toBe(`{"orgId":"o1","scopes":[]}`);
  });

  it("returns null for a missing key (a miss falls through to the cold path)", async () => {
    const cache = kvCredentialCache(bindings.KV_CONFIG);
    expect(await cache.get("k-absent")).toBeNull();
  });

  it("delete evicts the entry (invalidation on revoke/pause/rotate)", async () => {
    const cache = kvCredentialCache(bindings.KV_CONFIG);
    await cache.put("k-evict", "v");
    await cache.delete("k-evict");
    expect(await cache.get("k-evict")).toBeNull();
  });

  it("accepts a TTL backstop without throwing and the value is readable", async () => {
    const cache = kvCredentialCache(bindings.KV_CONFIG);
    await cache.put("k-ttl", "v", 300);
    expect(await cache.get("k-ttl")).toBe("v");
  });
});
