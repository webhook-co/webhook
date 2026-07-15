import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteAccount erases the identity, then signs out. The redirect MUST go to LOGOUT_URL, not LOGIN_URL —
// and here the stakes are highest: /login resumes a live IdP session, so a regression to it would re-
// authenticate a user who just ERASED their account (until Clear-Site-Data / the deleted row caught up).
// No UI test covers this; this file is the guard.

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const verifySession = vi.fn(async () => ({ userId: "usr_1", orgId: "org_1" }));
vi.mock("./session", async () => {
  const actual = await vi.importActual<typeof import("./session")>("./session");
  return { ...actual, verifySession: () => verifySession() };
});

const deleteOrgWithAudit = vi.fn(async () => ({ orgId: "org_1", deletedAt: "now" }));
// Default: one solo-owned org (nobody else in it) and nothing that would be orphaned — deletion proceeds.
const classifyOwnedOrgs = vi.fn(async () => ({
  wouldOrphan: [] as { orgId: string; name: string }[],
  soleOwnedSolo: [{ orgId: "personal_usr_1", name: "Personal" }],
}));
vi.mock("@webhook-co/db/org-lifecycle", () => ({
  deleteOrgWithAudit: (...a: unknown[]) => deleteOrgWithAudit(...a),
  classifyOwnedOrgs: (...a: unknown[]) => classifyOwnedOrgs(...a),
}));
vi.mock("./db", () => ({ getTenantDb: async () => ({ end: async () => {} }) }));
const deleteAccountRpc = vi.fn(async () => {});
vi.mock("./env", () => ({
  getAuditChainKey: async () => "AA".repeat(32),
  getAuthBaseUrl: () => "https://auth.test",
  getSessionSecret: async () => "s".repeat(32),
  getAccountDeleterBinding: () => ({ deleteAccount: deleteAccountRpc }),
}));
vi.mock("@webhook-co/shared", () => ({
  userActor: (id: string) => ({ kind: "user", id }),
  avatarR2Key: (id: string) => `user/${id}/avatar.webp`,
}));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
const deleteAvatar = vi.fn(async () => {});
const getAvatarBucket = vi.fn(async (): Promise<unknown> => ({ delete: deleteAvatar }));
vi.mock("./avatar-r2", () => ({ getAvatarBucket: () => getAvatarBucket() }));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

import { deleteAccount } from "./account-actions";
import { sessionCookieOptions } from "./session-cookie";
import { LOGOUT_URL, LOGIN_URL, SESSION_COOKIE } from "./session";

function form(confirm: string): FormData {
  const fd = new FormData();
  fd.set("confirm", confirm);
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("deleteAccount", () => {
  it("erases the identity, clears the cookie, and redirects to LOGOUT — never LOGIN", async () => {
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(`NEXT_REDIRECT:${LOGOUT_URL}`);

    expect(deleteAccountRpc).toHaveBeenCalledWith("usr_1");
    // The uploaded avatar (PII) is erased from R2 too — the identity delete only touches DB rows.
    expect(deleteAvatar).toHaveBeenCalledWith("user/usr_1/avatar.webp");
    expect(cookieStore.delete).toHaveBeenCalledWith({
      name: SESSION_COOKIE,
      ...sessionCookieOptions(),
    });
    // The stakes: a just-erased account must not be silently re-authenticated by a live IdP session.
    expect(LOGOUT_URL).not.toBe(LOGIN_URL);
    expect(LOGOUT_URL).toMatch(/\/logout$/);
  });

  it("refuses without the typed DELETE acknowledgement, and erases nothing", async () => {
    await expect(deleteAccount(form("nope"))).rejects.toThrow(/not confirmed/);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(deleteAccountRpc).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("skips the org delete when the user owns no org at all, but still erases the identity", async () => {
    classifyOwnedOrgs.mockResolvedValueOnce({ wouldOrphan: [], soleOwnedSolo: [] });
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(`NEXT_REDIRECT:${LOGOUT_URL}`);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(deleteAccountRpc).toHaveBeenCalledWith("usr_1");
  });

  it("BLOCKS erasure — and erases NOTHING — when the user solely owns an org with other members", async () => {
    classifyOwnedOrgs.mockResolvedValueOnce({
      wouldOrphan: [{ orgId: "org_team", name: "Acme Team" }],
      soleOwnedSolo: [{ orgId: "personal_usr_1", name: "Personal" }],
    });
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(/only owner of an organization/i);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled(); // not even the SAFE solo org — nothing is erased
    expect(deleteAccountRpc).not.toHaveBeenCalled(); // identity NOT erased → no orphaned org
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("NAMES the org to transfer — 'transfer ownership' is useless if you don't know which one", async () => {
    classifyOwnedOrgs.mockResolvedValueOnce({
      wouldOrphan: [{ orgId: "org_team", name: "Acme Team" }],
      soleOwnedSolo: [],
    });
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(/Acme Team/);
  });

  it("erases EVERY solo-owned org, not just the personal one (a cross-org orphan is still an orphan)", async () => {
    // The bug this slice fixes: an owner-invite can leave you the sole owner of an org that is NOT your own.
    classifyOwnedOrgs.mockResolvedValueOnce({
      wouldOrphan: [],
      soleOwnedSolo: [
        { orgId: "personal_usr_1", name: "Personal" },
        { orgId: "org_inherited", name: "Inherited Solo" },
      ],
    });
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(`NEXT_REDIRECT:${LOGOUT_URL}`);
    expect(deleteOrgWithAudit).toHaveBeenCalledTimes(2);
    expect(deleteAccountRpc).toHaveBeenCalledWith("usr_1");
  });
});
