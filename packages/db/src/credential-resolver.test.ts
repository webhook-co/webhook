import { describe, expect, it, vi } from "vitest";

import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "./credential";
import { InMemoryCredentialCache, type ResolvedPrincipal } from "./credential-cache";
import { createCredentialResolver, type ColdLookup } from "./credential-resolver";

const ORG = "11111111-1111-7111-8111-111111111111";
const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xc3) });

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return { orgId: ORG, scopes: ["events:read"], ...over };
}

describe("createCredentialResolver — hot/cold path", () => {
  it("COLD on first resolve (cache miss), then HOT on the second (no second cold lookup)", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

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
      hasher,
      cache,
      coldLookup: async () => principal(),
    });
    await resolver.resolve("whk_secret");
    const [key, value] = putSpy.mock.calls[0];
    expect(key).toBe(hasher.hash("whk_secret").toString("hex"));
    expect(value).not.toContain("whk_secret");
  });

  it("returns null and does NOT cache a negative (cold miss)", async () => {
    const cache = new InMemoryCredentialCache();
    const putSpy = vi.spyOn(cache, "put");
    const cold = vi.fn<ColdLookup>().mockResolvedValue(null);
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

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
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

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
    await cache.put(hasher.hash("whk_secret").toString("hex"), '{"not":"a principal"}');
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

    const result = await resolver.resolve("whk_secret");
    expect(result?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1); // garbage entry was not trusted
  });

  it("treats a NON-JSON cache entry as a miss, not an unhandled throw", async () => {
    // A truncated/partial KV write or an externally poisoned entry is not valid JSON at
    // all. The resolver must fall through to the cold path, never let JSON.parse throw out
    // (which would 500 a valid credential for the whole TTL).
    const cache = new InMemoryCredentialCache();
    await cache.put(hasher.hash("whk_secret").toString("hex"), "not json at all");
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

    const result = await resolver.resolve("whk_secret");
    expect(result?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1); // corrupt entry discarded, cold path ran
  });

  it("rejects a cached entry whose scopes array holds non-strings (fails closed)", async () => {
    // Valid JSON, right top-level kinds, but a structurally unsound principal: the guard
    // must validate scope element types, not just that scopes is an array.
    const cache = new InMemoryCredentialCache();
    await cache.put(
      hasher.hash("whk_secret").toString("hex"),
      JSON.stringify({ orgId: ORG, scopes: ["events:read", 42] }),
    );
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

    const result = await resolver.resolve("whk_secret");
    expect(result?.orgId).toBe(ORG);
    expect(result?.scopes).toEqual(["events:read"]); // the cold principal, not the poisoned one
    expect(cold).toHaveBeenCalledTimes(1);
  });

  it("rejects a cached entry whose sealedSecrets element is malformed (fails closed)", async () => {
    // Valid JSON with a sealedSecrets array, but an element is missing the base64 fields. The guard
    // must reject it (fall to the cold path) so the verify step never gets a half-formed secret that
    // would throw mid-unseal.
    const cache = new InMemoryCredentialCache();
    await cache.put(
      hasher.hash("whk_secret").toString("hex"),
      JSON.stringify({
        orgId: ORG,
        scopes: [],
        endpointId: "ep-1",
        sealedSecrets: [{ id: "s1", provider: "stripe" }], // missing ciphertextB64/nonce/etc.
      }),
    );
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal({ endpointId: "ep-1" }));
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

    const result = await resolver.resolve("whk_secret");
    expect(result?.endpointId).toBe("ep-1");
    expect(cold).toHaveBeenCalledTimes(1); // poisoned hot entry ignored; cold path taken
  });

  it("rejects a cached sealedSecrets element whose base64 field isn't valid base64 (fails closed)", async () => {
    // Structurally complete, but ciphertextB64 is non-base64 garbage. Buffer.from would decode it to
    // junk and defer the failure to GCM; the guard must reject it at the cache boundary instead.
    const cache = new InMemoryCredentialCache();
    await cache.put(
      hasher.hash("whk_secret").toString("hex"),
      JSON.stringify({
        orgId: ORG,
        scopes: [],
        endpointId: "ep-1",
        sealedSecrets: [
          {
            id: "s1",
            provider: "stripe",
            ciphertextB64: "!!! not base64 !!!",
            nonceB64: "AAAA",
            wrappedDekB64: "AAAA",
            kekRef: "local-dev-kek",
            envelopeVersion: 1,
            context: { orgId: ORG, endpointId: "ep-1", keyId: "k1" },
          },
        ],
      }),
    );
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal({ endpointId: "ep-1" }));
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });

    await resolver.resolve("whk_secret");
    expect(cold).toHaveBeenCalledTimes(1); // poisoned (non-base64) hot entry ignored; cold path taken
  });

  it("invalidateHash deletes by raw hash (admin revoke without the plaintext)", async () => {
    const cache = new InMemoryCredentialCache();
    const delSpy = vi.spyOn(cache, "delete");
    const resolver = createCredentialResolver({
      hasher,
      cache,
      coldLookup: async () => principal(),
    });
    const hash = hasher.hash("whk_secret");
    await resolver.invalidateHash(hash);
    expect(delSpy).toHaveBeenCalledWith(hash.toString("hex"));
  });
});

describe("createCredentialResolver — pepper rotation", () => {
  it("a key minted under the PREVIOUS pepper still resolves during the rotation window", async () => {
    const oldPepper = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xa1);
    const newPepper = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xb2);
    const oldHasher = createCredentialHasher({ current: oldPepper });
    const rotating = createCredentialHasher({ current: newPepper, previous: [oldPepper] });

    // A key whose stored hash was minted under the OLD pepper.
    const storedHash = oldHasher.hash("whk_legacy");
    const cold: ColdLookup = async (h) =>
      Buffer.compare(h, storedHash) === 0 ? principal() : null;

    const cache = new InMemoryCredentialCache();
    const resolver = createCredentialResolver({ hasher: rotating, cache, coldLookup: cold });
    // Current-pepper candidate misses; the previous-pepper candidate matches.
    expect((await resolver.resolve("whk_legacy"))?.orgId).toBe(ORG);

    // Without the previous pepper, the same key no longer resolves.
    const newOnly = createCredentialResolver({
      hasher: createCredentialHasher({ current: newPepper }),
      cache: new InMemoryCredentialCache(),
      coldLookup: cold,
    });
    expect(await newOnly.resolve("whk_legacy")).toBeNull();
  });
});

describe("createCredentialResolver — opt-in precheck (ADR-0073 edge guard)", () => {
  it("short-circuits to null BEFORE any cache.get or cold lookup when precheck fails", async () => {
    const cache = new InMemoryCredentialCache();
    const getSpy = vi.spyOn(cache, "get");
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({
      hasher,
      cache,
      coldLookup: cold,
      precheck: () => false, // e.g. a malformed/old-format key
    });

    expect(await resolver.resolve("whk_malformed")).toBeNull();
    expect(getSpy).not.toHaveBeenCalled(); // no KV hit
    expect(cold).not.toHaveBeenCalled(); // no DB hit — rejected at the edge
  });

  it("passes through the normal hot/cold path when precheck succeeds", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({
      hasher,
      cache,
      coldLookup: cold,
      precheck: () => true,
    });

    expect((await resolver.resolve("whk_ok"))?.orgId).toBe(ORG);
    expect(cold).toHaveBeenCalledTimes(1);
  });

  it("is opt-in: with no precheck, every credential resolves normally (ingest path unaffected)", async () => {
    const cache = new InMemoryCredentialCache();
    const cold = vi.fn<ColdLookup>().mockResolvedValue(principal());
    const resolver = createCredentialResolver({ hasher, cache, coldLookup: cold });
    expect((await resolver.resolve("whep_anything"))?.orgId).toBe(ORG);
  });
});
