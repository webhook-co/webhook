import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteAccount erases the identity, then signs out. The redirect MUST go to LOGOUT_URL, not LOGIN_URL —
// and here the stakes are highest: /login resumes a live IdP session, so a regression to it would re-
// authenticate a user who just ERASED their account (until Clear-Site-Data / the deleted row caught up).
// No UI test covers this; this file is the guard.

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const verifySession = vi.fn(async () => ({ userId: "usr_1", orgId: "org_1" }));
vi.mock("./session", async () => {
  const actual = await vi.importActual<typeof import("./session")>("./session");
  return { ...actual, verifySession: () => verifySession() };
});

const isOrgOwner = vi.fn(async () => true);
const deleteOrgWithAudit = vi.fn(async () => ({ orgId: "org_1", deletedAt: "now" }));
// Default census: a solo personal org (owner is the only member) — the guard lets deletion proceed.
const readOrgMembershipCensus = vi.fn(async () => ({ owners: 1, total: 1 }));
vi.mock("@webhook-co/db/org-lifecycle", () => ({
  isOrgOwner: (...a: unknown[]) => isOrgOwner(...a),
  deleteOrgWithAudit: (...a: unknown[]) => deleteOrgWithAudit(...a),
  personalOrgId: (userId: string) => `personal_${userId}`,
  readOrgMembershipCensus: (...a: unknown[]) => readOrgMembershipCensus(...a),
  // The real (pure) guard logic, so the census mock actually drives the branch.
  lastOwnerWouldOrphan: (c: { owners: number; total: number }) => c.owners === 1 && c.total > 1,
}));
vi.mock("./db", () => ({ getTenantDb: async () => ({ end: async () => {} }) }));
const deleteAccountRpc = vi.fn(async () => {});
vi.mock("./env", () => ({
  getAuditChainKey: async () => "AA".repeat(32),
  getAuthBaseUrl: () => "https://auth.test",
  getSessionSecret: async () => "s".repeat(32),
  getAccountDeleterBinding: () => ({ deleteAccount: deleteAccountRpc }),
}));
vi.mock("@webhook-co/shared", () => ({ userActor: (id: string) => ({ kind: "user", id }) }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));

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

  it("skips the org delete when the user no longer owns their personal org, but still erases the identity", async () => {
    isOrgOwner.mockResolvedValueOnce(false);
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(`NEXT_REDIRECT:${LOGOUT_URL}`);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(deleteAccountRpc).toHaveBeenCalledWith("usr_1");
  });

  it("BLOCKS erasure — and erases NOTHING — when the user is the sole owner of an org with other members", async () => {
    // The last-owner guard: deleting would leave a zero-owner org (unreachable, un-billed-out, alert-less).
    readOrgMembershipCensus.mockResolvedValueOnce({ owners: 1, total: 3 });
    await expect(deleteAccount(form("DELETE"))).rejects.toThrow(/only owner of an organization/i);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(deleteAccountRpc).not.toHaveBeenCalled(); // identity NOT erased → no orphaned org
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});
