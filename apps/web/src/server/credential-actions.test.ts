import { beforeEach, describe, expect, it, vi } from "vitest";

// The action gates on the session; stub it so the unit runs without a cookie.
vi.mock("./session", () => ({
  verifySession: vi.fn(async () => ({
    userId: "u",
    orgId: "o",
    user: { name: "", email: "", image: null },
  })),
}));

// The DB-touching mint (createApiKeyWithAudit over the tenant pool) — mocked here; the real path is
// covered by the db package's integration test. Echoes the narrowed input so the action's mapping shows.
const { mintApiKey } = vi.hoisted(() => ({ mintApiKey: vi.fn() }));
vi.mock("./credential-mint", () => ({ mintApiKey }));

import { createApiKey, revokeApiKey, revokeGrant } from "./credential-actions";

describe("createApiKey", () => {
  beforeEach(() => {
    mintApiKey.mockReset();
    mintApiKey.mockImplementation(async (input: { name: string; scopes: readonly string[] }) => ({
      id: "key_db_1",
      orgId: "o",
      name: input.name,
      scopes: [...input.scopes],
      start: "whk_3f9a…7c1d",
      expiresAt: null,
      plaintext: `whk_${"a".repeat(40)}`,
    }));
  });

  it("rejects an empty name without minting", async () => {
    expect((await createApiKey({ name: "   ", scopes: ["events:read"] })).ok).toBe(false);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("rejects when no grantable scope is chosen, without minting", async () => {
    expect((await createApiKey({ name: "k", scopes: [] })).ok).toBe(false);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("narrows scopes to the grantable set before minting — drops reserved/unknown scopes", async () => {
    const result = await createApiKey({
      name: "k",
      scopes: ["events:read", "keys:manage", "totally:bogus"],
    });
    expect(result.ok).toBe(true);
    // the action narrows BEFORE the mint — keys:manage never reaches the DB
    expect(mintApiKey).toHaveBeenCalledWith({
      orgId: "o",
      userId: "u",
      name: "k",
      scopes: ["events:read"],
    });
    if (result.ok) expect(result.key.scopes).toEqual(["events:read"]);
  });

  it("returns the minted key + one-time plaintext (distinct from the redacted start)", async () => {
    const result = await createApiKey({ name: "CI deploy", scopes: ["events:read"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plaintext).toMatch(/^whk_/);
      expect(result.key.start).toContain("…");
      expect(result.key.start).not.toBe(result.plaintext);
      expect(result.key.name).toBe("CI deploy");
    }
  });

  it("surfaces an error (no throw) when the mint fails", async () => {
    mintApiKey.mockImplementation(async () => {
      throw new Error("db down");
    });
    expect((await createApiKey({ name: "k", scopes: ["events:read"] })).ok).toBe(false);
  });
});

describe("revokeApiKey / revokeGrant (mock)", () => {
  it("rejects a missing key id", async () => {
    expect((await revokeApiKey("   ")).ok).toBe(false);
  });

  it("revokes a key by id", async () => {
    expect((await revokeApiKey("key_live")).ok).toBe(true);
  });

  it("rejects a missing grant id", async () => {
    expect((await revokeGrant("")).ok).toBe(false);
  });

  it("revokes a grant by id", async () => {
    expect((await revokeGrant("grant_live")).ok).toBe(true);
  });
});
