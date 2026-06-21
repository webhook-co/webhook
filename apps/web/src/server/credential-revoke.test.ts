import { afterEach, describe, expect, it, vi } from "vitest";

import { type RevokeDeps, revokeGrantById, revokeKeyById } from "./credential-revoke";

function makeDeps(over: Partial<RevokeDeps> = {}): RevokeDeps {
  return {
    revokeKey: vi.fn(async () => ({ keyHash: Buffer.from("hash-1") })),
    revokeGrant: vi.fn(async () => ({
      revokedKeyHashes: [Buffer.from("h-1"), Buffer.from("h-2")],
    })),
    evict: vi.fn(async () => {}),
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revokeKeyById", () => {
  it("revokes the key (org-scoped, by the session user) and evicts its hash from KV", async () => {
    const deps = makeDeps();
    await revokeKeyById({ orgId: "o", userId: "u", keyId: "k1" }, deps);
    expect(deps.revokeKey).toHaveBeenCalledWith("o", "k1", "u");
    expect(deps.evict).toHaveBeenCalledOnce();
  });

  it("does not evict when nothing was revoked (RLS / already-revoked → keyHash null)", async () => {
    const deps = makeDeps({ revokeKey: vi.fn(async () => ({ keyHash: null })) });
    await revokeKeyById({ orgId: "o", userId: "u", keyId: "k1" }, deps);
    expect(deps.evict).not.toHaveBeenCalled();
  });

  it("rethrows when the DB revoke itself fails (a genuine failure — nothing was revoked)", async () => {
    const deps = makeDeps({
      revokeKey: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(revokeKeyById({ orgId: "o", userId: "u", keyId: "k1" }, deps)).rejects.toThrow(
      "db down",
    );
  });

  it("does NOT rethrow when eviction fails after a committed revoke — the DB stamp is durable, the stale entry lapses within the cache TTL; it warns (scrubbed) instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      evict: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
    });
    await expect(
      revokeKeyById({ orgId: "o", userId: "u", keyId: "k1" }, deps),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    // The scrubbed log carries the opaque id + counts, never the key hash or plaintext.
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("k1");
    expect(logged).not.toContain("hash-1");
  });
});

describe("revokeGrantById", () => {
  it("revokes the grant and evicts EVERY cascaded child-key hash from KV", async () => {
    const deps = makeDeps();
    await revokeGrantById({ orgId: "o", userId: "u", grantId: "g1" }, deps);
    expect(deps.revokeGrant).toHaveBeenCalledWith("o", "g1", "u");
    expect(deps.evict).toHaveBeenCalledTimes(2);
  });

  it("attempts EVERY cascaded eviction even when one fails, and does not rethrow (allSettled, not all-or-nothing)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const evict = vi.fn(async (hash: Buffer) => {
      if (hash.equals(Buffer.from("h-1"))) throw new Error("KV unavailable");
    });
    const deps = makeDeps({ evict });
    await expect(
      revokeGrantById({ orgId: "o", userId: "u", grantId: "g1" }, deps),
    ).resolves.toBeUndefined();
    // The failure of h-1 must not abandon h-2 — both evictions are attempted.
    expect(evict).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("g1");
  });

  it("rethrows when the grant revoke itself fails (a genuine failure — nothing was revoked)", async () => {
    const deps = makeDeps({
      revokeGrant: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(revokeGrantById({ orgId: "o", userId: "u", grantId: "g1" }, deps)).rejects.toThrow(
      "db down",
    );
  });
});
