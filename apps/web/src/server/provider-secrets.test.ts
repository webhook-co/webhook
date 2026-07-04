import { describe, expect, it, vi } from "vitest";

import type { ProviderSecretMetadata } from "@webhook-co/db/provider-secrets";

import { loadProviderSecrets, type ProviderSecretReaders } from "./provider-secrets";

const ORG = "22222222-2222-2222-2222-222222222222";
const ENDPOINT = "11111111-1111-1111-1111-111111111111";
const META: ProviderSecretMetadata = {
  id: "key-1",
  provider: "stripe",
  status: "active",
  label: "prod",
  createdAt: new Date("2026-07-01T00:00:00Z"),
};

function readers(overrides: Partial<ProviderSecretReaders> = {}): ProviderSecretReaders {
  return {
    list: vi.fn(async () => [META]),
    ...overrides,
  };
}

describe("loadProviderSecrets", () => {
  it("returns ok with the metadata rows (no ciphertext / plaintext)", async () => {
    const res = await loadProviderSecrets(ORG, ENDPOINT, readers());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.items).toEqual([META]);
    // Guard: only non-secret metadata keys are present.
    expect(Object.keys(res.items[0]).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "provider",
      "status",
    ]);
  });

  it("returns error (never throws) on a db fault", async () => {
    const res = await loadProviderSecrets(
      ORG,
      ENDPOINT,
      readers({
        list: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(res.status).toBe("error");
  });
});
