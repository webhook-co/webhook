import { describe, expect, it, vi } from "vitest";

import type { ReplayDestinationRecord } from "@webhook-co/db/replay-destinations";

import {
  createDestination,
  enableDestination,
  InvalidDestinationUrlError,
  removeDestination,
  requireSealer,
  rotateDestinationSecret,
  setDestinationOrdered,
  SealerUnavailableError,
  type ReplayDestinationDeps,
} from "./replay-destination-mutations";

const REC: ReplayDestinationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  url: "https://hooks.example.com/in",
  label: "prod",
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  lastValidatedAt: new Date("2026-07-01T00:00:00Z"),
  ordered: false,
  disabledAt: null,
};

function deps(overrides: Partial<ReplayDestinationDeps> = {}): ReplayDestinationDeps {
  return {
    create: vi.fn(async () => ({ record: REC, signingSecret: "whsec_one_time" })),
    remove: vi.fn(async () => ({ id: REC.id, deletedAt: new Date() })),
    enable: vi.fn(async () => REC),
    setOrdered: vi.fn(async () => ({ ...REC, ordered: true })),
    rotate: vi.fn(async () => ({ keyId: "key-1", secret: "whsec_rotated" })),
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

describe("createDestination", () => {
  it("rejects a non-https URL BEFORE touching the db (fail-closed)", async () => {
    const d = deps();
    await expect(
      createDestination({ orgId: REC.orgId, url: "http://hooks.example.com", actor: "u1" }, d),
    ).rejects.toMatchObject({ name: "InvalidDestinationUrlError", reason: "not_https" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("rejects an IP-literal host before the db", async () => {
    const d = deps();
    await expect(
      createDestination({ orgId: REC.orgId, url: "https://169.254.169.254/x", actor: "u1" }, d),
    ).rejects.toBeInstanceOf(InvalidDestinationUrlError);
    expect(d.create).not.toHaveBeenCalled();
  });

  it("canonicalizes a valid URL and passes the CANONICAL form to the db", async () => {
    const d = deps();
    const res = await createDestination(
      {
        orgId: REC.orgId,
        url: "https://Hooks.Example.com:443/in#frag",
        label: "prod",
        actor: "u1",
      },
      d,
    );
    // Host lowercased, default port + fragment stripped by the canonicalizer.
    expect(d.create).toHaveBeenCalledWith(REC.orgId, "https://hooks.example.com/in", "prod", "u1");
    expect(res.signingSecret).toBe("whsec_one_time");
    expect(res.record).toBe(REC);
  });

  it("passes a null label through when omitted", async () => {
    const d = deps();
    await createDestination(
      { orgId: REC.orgId, url: "https://hooks.example.com/in", actor: "u1" },
      d,
    );
    expect(d.create).toHaveBeenCalledWith(REC.orgId, "https://hooks.example.com/in", null, "u1");
  });
});

describe("lifecycle pass-throughs", () => {
  it("rotateDestinationSecret returns the one-time secret", async () => {
    const res = await rotateDestinationSecret(
      { orgId: REC.orgId, destinationId: REC.id, actor: "u1" },
      deps(),
    );
    expect(res).toEqual({ keyId: "key-1", secret: "whsec_rotated" });
  });

  it("rotateDestinationSecret returns null when the destination isn't live (NOT_FOUND parity)", async () => {
    const res = await rotateDestinationSecret(
      { orgId: REC.orgId, destinationId: REC.id, actor: "u1" },
      deps({ rotate: vi.fn(async () => null) }),
    );
    expect(res).toBeNull();
  });

  it("removeDestination returns null on not-found", async () => {
    const res = await removeDestination(
      { orgId: REC.orgId, destinationId: REC.id, actor: "u1" },
      deps({ remove: vi.fn(async () => null) }),
    );
    expect(res).toBeNull();
  });

  it("enableDestination returns the updated record", async () => {
    const res = await enableDestination(
      { orgId: REC.orgId, destinationId: REC.id, actor: "u1" },
      deps(),
    );
    expect(res).toBe(REC);
  });

  it("setDestinationOrdered threads the ordered flag", async () => {
    const rotate = deps();
    await setDestinationOrdered(
      { orgId: REC.orgId, destinationId: REC.id, ordered: true, actor: "u1" },
      rotate,
    );
    expect(rotate.setOrdered).toHaveBeenCalledWith(REC.orgId, REC.id, true, "u1");
  });
});
