import { describe, expect, it, vi } from "vitest";

import { hashCredential } from "./credential";
import { InMemoryCredentialCache, type ResolvedPrincipal } from "./credential-cache";
import { createCredentialResolver, type ColdLookup } from "./credential-resolver";

const ORG = "11111111-1111-7111-8111-111111111111";

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return { orgId: ORG, scopes: ["events:read"], ...over };
}

describe("createCredentialResolver — hot/cold path (S3)", () => {
  it("COLD on first resolve (cache miss), then HOT on the second (no second cold lookup)", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ cache, coldLookup: cold });

    const first = await resolver.resolve("whk_secret");
    expect(first?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1); // cold path ran on the miss

    const second = await resolver.resolve("whk_secret");
    expect(second?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1); // STILL 1 — served from KV, no cold lookup
  });

  it("caches under the hash hex, never the plaintext", async () => {
    const cache = new InMemoryCredentialCache();
    const putSpy = vi.spyOn(cache, "put");
    const resolver = createCredentialResolver({
      cache,
      coldLookup: async () => principal(),
    });
    await resolver.resolve("whk_secret");
    const [key, value] = putSpy.mock.calls[0];
    expect(key).toBe(hashCredential("whk_secret").toString("hex"));
    expect(value).not.toContain("whk_secret");
  });

  it("returns null and does NOT cache a negative (cold miss)", async () => {
    const cache = new InMemoryCredentialCache();
    const putSpy = vi.spyOn(cache, "put");
    const cold = vi.fn<ColdLookup>().mockResolvedValue(null);
    const resolver = createCredentialResolver({ cache, coldLookup: cold });

    expect(await resolver.resolve("whk_nope")).toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    // A negative is not pinned: a later positive resolves (e.g. key just created).
    cold.mockResolvedValue(principal());
    expect(await resolver.resolve("whk_nope")).not.toBeNull();
    expect(cold).toHaveBeenCalledTimes(2);
  });

  it("invalidate(plaintext) deletes the KV entry so the next resolve takes the cold path", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ cache, coldLookup: cold });

    await resolver.resolve("whk_secret"); // populate KV
    expect(cold).toHaveBeenCalledTimes(1);

    // Revocation: the row is now revoked AND the cache is invalidated.
    cold.mockResolvedValue(null);
    await resolver.invalidate("whk_secret");

    expect(await resolver.resolve("whk_secret")).toBeNull(); // cold path sees revoked
    expect(cold).toHaveBeenCalledTimes(2); // cold ran again (KV entry was gone)
  });

  it("treats a malformed cache entry as a miss (fails closed to the cold path)", async () => {
    const cache = new InMemoryCredentialCache();
    await cache.put(hashCredential("whk_secret").toString("hex"), '{"not":"a principal"}');
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ cache, coldLookup: cold });

    const result = await resolver.resolve("whk_secret");
    expect(result?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1); // garbage entry was not trusted
  });

  it("invalidateHash deletes by raw hash (admin revoke without the plaintext)", async () => {
    const cache = new InMemoryCredentialCache();
    const delSpy = vi.spyOn(cache, "delete");
    const resolver = createCredentialResolver({ cache, coldLookup: async () => principal() });
    const hash = hashCredential("whk_secret");
    await resolver.invalidateHash(hash);
    expect(delSpy).toHaveBeenCalledWith(hash.toString("hex"));
  });
});
