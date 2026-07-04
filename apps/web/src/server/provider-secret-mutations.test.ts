import { describe, expect, it, vi } from "vitest";

import {
  addSecret,
  requireSealer,
  revokeSecret,
  SealerUnavailableError,
  type ProviderSecretDeps,
} from "./provider-secret-mutations";

const ORG = "22222222-2222-2222-2222-222222222222";
const ENDPOINT = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";

// A duck-typed CapabilityFault matching what the shared write core throws — asserted structurally
// (name + code), never by instanceof, so it stays robust across the contract-module boundary.
class CapabilityFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityFault";
  }
}

function deps(overrides: Partial<ProviderSecretDeps> = {}): ProviderSecretDeps {
  return {
    add: vi.fn(async () => ({ id: SECRET_ID, provider: "stripe", status: "active" as const })),
    revoke: vi.fn(async () => ({ id: SECRET_ID, revokedAt: new Date("2026-07-04T00:00:00Z") })),
    ...overrides,
  };
}

describe("requireSealer — fail closed", () => {
  it("throws SealerUnavailableError when the sealer is undefined", () => {
    expect(() => requireSealer(undefined)).toThrow(SealerUnavailableError);
  });

  it("returns the sealer when present", () => {
    const s = { sealString: async () => ({}) } as never;
    expect(requireSealer(s)).toBe(s);
  });
});

describe("addSecret", () => {
  it("passes the input through to the write core and returns its metadata", async () => {
    const d = deps();
    const res = await addSecret(
      {
        orgId: ORG,
        endpointId: ENDPOINT,
        provider: "stripe",
        kind: "signing_secret",
        secret: "whsec_abc",
        label: "prod",
        actor: "user-1",
      },
      d,
    );
    expect(d.add).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        endpointId: ENDPOINT,
        provider: "stripe",
        label: "prod",
      }),
    );
    expect(res).toEqual({ id: SECRET_ID, provider: "stripe", status: "active" });
  });

  it("propagates a CapabilityFault (NOT_FOUND / VALIDATION_ERROR / RATE_LIMITED) unchanged", async () => {
    const d = deps({
      add: vi.fn(async () => {
        throw new CapabilityFault("VALIDATION_ERROR", "a Standard Webhooks secret must be base64");
      }),
    });
    await expect(
      addSecret(
        {
          orgId: ORG,
          endpointId: ENDPOINT,
          provider: "stripe",
          kind: "signing_secret",
          secret: "not-base64",
          actor: "user-1",
        },
        d,
      ),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "VALIDATION_ERROR" });
  });

  it("never leaks the raw secret through any logged value", async () => {
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await addSecret(
      {
        orgId: ORG,
        endpointId: ENDPOINT,
        provider: "stripe",
        kind: "signing_secret",
        secret: "whsec_super_secret_value",
        actor: "user-1",
      },
      deps(),
    );
    for (const call of [...spyErr.mock.calls, ...spyWarn.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("whsec_super_secret_value");
    }
    spyErr.mockRestore();
    spyWarn.mockRestore();
  });
});

describe("revokeSecret", () => {
  it("returns the revoke metadata on success", async () => {
    const res = await revokeSecret(
      { orgId: ORG, endpointId: ENDPOINT, secretId: SECRET_ID, actor: "user-1" },
      deps(),
    );
    expect(res).toEqual({ id: SECRET_ID, revokedAt: new Date("2026-07-04T00:00:00Z") });
  });

  it("returns null when the secret isn't found (unknown / cross-org / already-revoked)", async () => {
    const res = await revokeSecret(
      { orgId: ORG, endpointId: ENDPOINT, secretId: SECRET_ID, actor: "user-1" },
      deps({ revoke: vi.fn(async () => null) }),
    );
    expect(res).toBeNull();
  });
});
