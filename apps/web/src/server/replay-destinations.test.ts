import { describe, expect, it, vi } from "vitest";

import type { ReplayDestinationRecord } from "@webhook-co/db/replay-destinations";

import {
  loadDestinations,
  loadSigningSecrets,
  type DestinationReaders,
} from "./replay-destinations";

const ORG = "22222222-2222-2222-2222-222222222222";
const REC: ReplayDestinationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: ORG,
  url: "https://hooks.example.com/in",
  label: "prod",
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  lastValidatedAt: new Date("2026-07-01T00:00:00Z"),
  ordered: false,
  disabledAt: null,
};

function readers(overrides: Partial<DestinationReaders> = {}): DestinationReaders {
  return {
    list: vi.fn(async () => [REC]),
    secrets: vi.fn(async () => [
      { id: "key-1", status: "active" as const, createdAt: new Date("2026-07-01T00:00:00Z") },
    ]),
    live: vi.fn(async () => ({ id: REC.id, url: REC.url })),
    ...overrides,
  };
}

describe("loadDestinations", () => {
  it("returns ok with a browser-safe projection that strips orgId", async () => {
    const res = await loadDestinations(ORG, readers());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).not.toHaveProperty("orgId");
    expect(res.items[0].id).toBe(REC.id);
    expect(res.items[0].url).toBe(REC.url);
  });

  it("returns error (never throws) on a db fault", async () => {
    const res = await loadDestinations(
      ORG,
      readers({
        list: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(res.status).toBe("error");
  });
});

describe("loadSigningSecrets", () => {
  it("returns ok metadata (id/status/createdAt) — never ciphertext", async () => {
    const res = await loadSigningSecrets(ORG, REC.id, readers());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.items[0]).toEqual({
      id: "key-1",
      status: "active",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
  });

  it("returns not_found when the destination isn't live (soft-deleted / unknown / cross-org)", async () => {
    const res = await loadSigningSecrets(ORG, REC.id, readers({ live: vi.fn(async () => null) }));
    expect(res.status).toBe("not_found");
  });

  it("does not read secrets for a non-live destination (no key-history leak)", async () => {
    const secrets = vi.fn();
    await loadSigningSecrets(ORG, REC.id, readers({ live: vi.fn(async () => null), secrets }));
    expect(secrets).not.toHaveBeenCalled();
  });

  it("returns error on a db fault", async () => {
    const res = await loadSigningSecrets(
      ORG,
      REC.id,
      readers({
        secrets: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    );
    expect(res.status).toBe("error");
  });
});
