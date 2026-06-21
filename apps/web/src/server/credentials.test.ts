import { describe, expect, it, vi } from "vitest";

import { type CredentialReaders, loadCredentials } from "./credentials";

const grant = {
  id: "g1",
  status: "active" as const,
  authMethod: "device_code" as const,
  deviceName: "Dana's Mac",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  lastUsedAt: null,
  approvedAt: new Date("2026-05-01T00:00:00Z"),
  revokedAt: null,
  expiresAt: null,
};
const childKey = {
  id: "k1",
  name: "wbhk cli",
  start: "whk_2aF9…7c1d",
  scopes: ["events:read"],
  createdAt: new Date("2026-05-01T00:00:00Z"),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};
const standaloneKey = { ...childKey, id: "k2", name: "Production", start: "whsec_9b3a…e21f" };

function makeReaders(over: Partial<CredentialReaders> = {}): CredentialReaders {
  return {
    listGrants: vi.fn(async () => [grant]),
    listApiKeysForGrant: vi.fn(async () => [childKey]),
    listStandaloneApiKeys: vi.fn(async () => [standaloneKey]),
    ...over,
  };
}

describe("loadCredentials", () => {
  it("joins each grant with its child keys and lists standalone keys", async () => {
    const readers = makeReaders();
    const result = await loadCredentials("org_1", readers);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].id).toBe("g1");
      expect(result.devices[0].keys.map((k) => k.id)).toEqual(["k1"]);
      expect(result.keys.map((k) => k.id)).toEqual(["k2"]);
    }
    expect(readers.listGrants).toHaveBeenCalledWith("org_1");
    expect(readers.listApiKeysForGrant).toHaveBeenCalledWith("org_1", "g1");
    expect(readers.listStandaloneApiKeys).toHaveBeenCalledWith("org_1");
  });

  it("returns an error result when a read throws (db/Hyperdrive fault)", async () => {
    const result = await loadCredentials(
      "org_1",
      makeReaders({
        listGrants: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(result.status).toBe("error");
  });

  it("handles an org with no grants or keys", async () => {
    const result = await loadCredentials(
      "org_1",
      makeReaders({
        listGrants: vi.fn(async () => []),
        listStandaloneApiKeys: vi.fn(async () => []),
      }),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.devices).toEqual([]);
      expect(result.keys).toEqual([]);
    }
  });
});
