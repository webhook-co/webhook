import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({
    userId: "u_1",
    orgId: "o_1",
    user: { name: "Old Name", email: "dana@example.com", image: null as string | null },
  })),
}));
vi.mock("./session", () => ({ verifySession }));

const { updateName, getOnboardingBinding } = vi.hoisted(() => {
  const updateName = vi.fn(async () => ({ updated: true }));
  return { updateName, getOnboardingBinding: vi.fn(() => ({ updateName })) };
});
vi.mock("./env", () => ({ getOnboardingBinding }));

const { remintSessionForProfile } = vi.hoisted(() => ({
  remintSessionForProfile: vi.fn(async () => "ok" as const),
}));
vi.mock("./session-remint", () => ({ remintSessionForProfile }));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

import { updateDisplayNameAction } from "./profile-actions";

const form = (name?: string) => {
  const fd = new FormData();
  if (name !== undefined) fd.set("name", name);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  updateName.mockResolvedValue({ updated: true });
  getOnboardingBinding.mockReturnValue({ updateName });
  remintSessionForProfile.mockResolvedValue("ok");
});

describe("updateDisplayNameAction", () => {
  it("updates the name, re-mints the session, and returns ok", async () => {
    expect(await updateDisplayNameAction(form("Dana Kessler"))).toEqual({ ok: true });
    expect(updateName).toHaveBeenCalledWith("u_1", "Dana Kessler"); // the SERVER-verified userId, trimmed name
    // Re-mint carries the new name forward with the session's own email/image.
    expect(remintSessionForProfile).toHaveBeenCalledWith({
      name: "Dana Kessler",
      email: "dana@example.com",
      image: null,
    });
  });

  it("trims the name before writing", async () => {
    await updateDisplayNameAction(form("   Grace Hopper   "));
    expect(updateName).toHaveBeenCalledWith("u_1", "Grace Hopper");
  });

  it("rejects an empty name without writing or re-minting", async () => {
    expect(await updateDisplayNameAction(form("   "))).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(updateName).not.toHaveBeenCalled();
    expect(remintSessionForProfile).not.toHaveBeenCalled();
  });

  it("rejects a name that grows beyond the cap", async () => {
    const res = await updateDisplayNameAction(form("x".repeat(201)));
    expect(res).toMatchObject({ ok: false });
    expect(updateName).not.toHaveBeenCalled();
  });

  it("still lets a user with an already-over-cap name edit it (no hard lockout)", async () => {
    // A user whose stored name is 250 chars (a long OAuth name) must be able to edit — as long as they don't
    // make it LONGER. The cap only blocks new growth.
    const long = "y".repeat(250);
    verifySession.mockResolvedValueOnce({
      userId: "u_1",
      orgId: "o_1",
      user: { name: long, email: "dana@example.com", image: null },
    });
    expect(await updateDisplayNameAction(form(long.slice(0, 249)))).toEqual({ ok: true });
    expect(updateName).toHaveBeenCalledWith("u_1", long.slice(0, 249));
  });

  it("returns a graceful error (no crash) when the RPC throws", async () => {
    updateName.mockRejectedValueOnce(new Error("method not found / hyperdrive blip"));
    expect(await updateDisplayNameAction(form("New Name"))).toMatchObject({ ok: false });
    expect(remintSessionForProfile).not.toHaveBeenCalled();
  });

  it("is a no-op when the name is unchanged — no write, no re-mint", async () => {
    expect(await updateDisplayNameAction(form("Old Name"))).toEqual({ ok: true });
    expect(updateName).not.toHaveBeenCalled();
    expect(remintSessionForProfile).not.toHaveBeenCalled();
  });

  it("returns an error (and does NOT re-mint) when the binding is unavailable", async () => {
    getOnboardingBinding.mockReturnValueOnce(undefined);
    expect(await updateDisplayNameAction(form("New"))).toMatchObject({ ok: false });
    expect(remintSessionForProfile).not.toHaveBeenCalled();
  });

  it("returns an error (and does NOT re-mint) when the DB refuses the write", async () => {
    updateName.mockResolvedValueOnce({ updated: false });
    expect(await updateDisplayNameAction(form("New"))).toMatchObject({ ok: false });
    expect(remintSessionForProfile).not.toHaveBeenCalled();
  });

  it("is gated on the session", async () => {
    verifySession.mockRejectedValueOnce(new Error("no session"));
    await expect(updateDisplayNameAction(form("New"))).rejects.toThrow(/no session/);
    expect(updateName).not.toHaveBeenCalled();
  });
});
