import { beforeEach, describe, expect, it, vi } from "vitest";

const readOnboardingState = vi.fn();
const completeOnboarding = vi.fn();
const updateUserName = vi.fn();
const end = vi.fn(async () => {});
const createClient = vi.fn(() => ({ end }));
vi.mock("@webhook-co/db", () => ({
  readOnboardingState: (...a: unknown[]) => readOnboardingState(...a),
  completeOnboarding: (...a: unknown[]) => completeOnboarding(...a),
  updateUserName: (...a: unknown[]) => updateUserName(...a),
  createClient: (...a: unknown[]) => createClient(...a),
}));

import { completeOnboardingRpc, readOnboardingRpc, updateNameRpc } from "./onboarding-deps";

const env = { HYPERDRIVE_AUTH: { connectionString: "postgres://auth" } };

beforeEach(() => vi.clearAllMocks());

describe("readOnboardingRpc", () => {
  it("serialises Dates to ISO for the worker hop, and closes the pool", async () => {
    readOnboardingState.mockResolvedValue({
      firstName: "Ada",
      lastName: "Lovelace",
      name: "Ada Lovelace",
      onboardedAt: new Date("2026-07-14T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const dto = await readOnboardingRpc(env, "usr_1");

    expect(dto).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      name: "Ada Lovelace",
      onboardedAtIso: "2026-07-14T00:00:00.000Z",
      createdAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(end).toHaveBeenCalledOnce(); // never leak the identity-realm pool
  });

  it("passes onboardedAtIso: null through for a not-yet-onboarded user", async () => {
    readOnboardingState.mockResolvedValue({
      firstName: null,
      lastName: null,
      name: "Ada",
      onboardedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect((await readOnboardingRpc(env, "usr_1"))!.onboardedAtIso).toBeNull();
  });

  it("returns null for a missing user", async () => {
    readOnboardingState.mockResolvedValue(null);
    expect(await readOnboardingRpc(env, "usr_x")).toBeNull();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("completeOnboardingRpc", () => {
  // The timestamp is generated on the AUTH side, not taken from the caller — so a client cannot supply a time
  // to flip the gate. This asserts the db function is handed a real Date the RPC minted.
  it("stamps onboardedAt server-side and forwards the name", async () => {
    completeOnboarding.mockResolvedValue(true);

    const res = await completeOnboardingRpc(env, {
      userId: "usr_1",
      firstName: "Grace",
      lastName: "Hopper",
    });

    expect(res).toEqual({ completed: true });
    const arg = completeOnboarding.mock.calls[0][1];
    expect(arg.userId).toBe("usr_1");
    expect(arg.firstName).toBe("Grace");
    expect(arg.lastName).toBe("Hopper");
    expect(arg.onboardedAt).toBeInstanceOf(Date);
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports completed: false when the user is gone", async () => {
    completeOnboarding.mockResolvedValue(false);
    expect(
      await completeOnboardingRpc(env, { userId: "x", firstName: "A", lastName: "B" }),
    ).toEqual({
      completed: false,
    });
  });
});

describe("updateNameRpc", () => {
  it("forwards the name to the db helper and closes the pool", async () => {
    updateUserName.mockResolvedValue(true);

    const res = await updateNameRpc(env, { userId: "usr_1", name: "Dana Kessler" });

    expect(res).toEqual({ updated: true });
    expect(updateUserName.mock.calls[0][1]).toEqual({ userId: "usr_1", name: "Dana Kessler" });
    expect(end).toHaveBeenCalledOnce(); // never leak the identity-realm pool
  });

  it("reports updated: false when the write is refused (user gone / empty name)", async () => {
    updateUserName.mockResolvedValue(false);
    expect(await updateNameRpc(env, { userId: "x", name: "" })).toEqual({ updated: false });
    expect(end).toHaveBeenCalledOnce();
  });
});
