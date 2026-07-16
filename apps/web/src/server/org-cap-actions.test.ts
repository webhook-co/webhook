import { beforeEach, describe, expect, it, vi } from "vitest";

const { isOrgOwner, setOrgFreeCapKeep, verifySession, getTenantDb, revalidatePath } = vi.hoisted(
  () => ({
    isOrgOwner: vi.fn(),
    setOrgFreeCapKeep: vi.fn(),
    verifySession: vi.fn(),
    getTenantDb: vi.fn(),
    revalidatePath: vi.fn(),
  }),
);

vi.mock("@webhook-co/db/org-lifecycle", () => ({ isOrgOwner, setOrgFreeCapKeep }));
vi.mock("@/server/session", () => ({ verifySession }));
vi.mock("@/server/db", () => ({ getTenantDb }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { setOrgKeepAction } from "./org-cap-actions";

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({ userId: "usr_1" });
  getTenantDb.mockResolvedValue({});
  isOrgOwner.mockResolvedValue(true);
  setOrgFreeCapKeep.mockResolvedValue(undefined);
});

describe("setOrgKeepAction", () => {
  it("marks an org the caller owns", async () => {
    await expect(setOrgKeepAction("org_1", true)).resolves.toEqual({ ok: true });
    expect(setOrgFreeCapKeep).toHaveBeenCalledWith({}, "org_1", "usr_1", true);
    expect(revalidatePath).toHaveBeenCalledWith("/account/organizations");
  });

  it("unmarks too", async () => {
    await expect(setOrgKeepAction("org_1", false)).resolves.toEqual({ ok: true });
    expect(setOrgFreeCapKeep).toHaveBeenCalledWith({}, "org_1", "usr_1", false);
  });

  it("REFUSES an org the caller doesn't own — RLS scopes the write, it does not authorize it", async () => {
    // The load-bearing check. `setOrgFreeCapKeep` runs under the TARGET org's tenant context, so RLS only
    // guarantees the write lands in that org — not that this user may make it. Without this gate any signed-in
    // user could mark any org id they could guess, reordering a stranger's cap survivors.
    isOrgOwner.mockResolvedValue(false);
    await expect(setOrgKeepAction("org_someone_else", true)).resolves.toEqual({
      ok: false,
      error: "You can only change organizations you own.",
    });
    expect(setOrgFreeCapKeep).not.toHaveBeenCalled();
  });

  it("gates on OWNERSHIP, not membership — the cap is counted against owners", async () => {
    isOrgOwner.mockResolvedValue(false); // a member/admin is not an owner
    const res = await setOrgKeepAction("org_1", true);
    expect(res.ok).toBe(false);
    expect(isOrgOwner).toHaveBeenCalledWith({}, "usr_1", "org_1");
  });

  it("gives the same answer for a nonexistent org as for someone else's — no existence oracle", async () => {
    isOrgOwner.mockResolvedValue(false);
    const missing = await setOrgKeepAction("org_does_not_exist", true);
    const theirs = await setOrgKeepAction("org_theirs", true);
    expect(missing).toEqual(theirs);
  });

  it("returns an inline error (never throws) when the write fails", async () => {
    setOrgFreeCapKeep.mockRejectedValue(new Error("db down"));
    await expect(setOrgKeepAction("org_1", true)).resolves.toEqual({
      ok: false,
      error: "Couldn't save that just now. Try again.",
    });
    expect(revalidatePath).not.toHaveBeenCalled(); // nothing changed → don't bust the cache
  });

  it("requires a session — an unauthenticated call never reaches the ownership check", async () => {
    verifySession.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setOrgKeepAction("org_1", true)).rejects.toThrow("NEXT_REDIRECT");
    expect(isOrgOwner).not.toHaveBeenCalled();
    expect(setOrgFreeCapKeep).not.toHaveBeenCalled();
  });
});
