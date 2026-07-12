import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn(async () => ({
  userId: "usr_1",
  orgId: "org_1",
  user: { name: "Dana", email: "dana@e.test", image: null },
}));
vi.mock("./session", async () => {
  const actual = await vi.importActual<typeof import("./session")>("./session");
  return { ...actual, verifySession: () => verifySession() };
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
const readMembershipRole = vi.fn();
vi.mock("@webhook-co/db/orgs", () => ({
  readMembershipRole: (...a: unknown[]) => readMembershipRole(...a),
}));
// Tenant wrappers as pass-throughs: withTenantDb(fn) → fn(app); withTenant(app, org, fn) → fn(tx).
vi.mock("@webhook-co/db/client", () => ({
  withTenant: (_app: unknown, _org: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { requireOrgAccess } from "./org-access";
import { LOGIN_URL } from "./session";

beforeEach(() => vi.clearAllMocks());

describe("requireOrgAccess", () => {
  it("returns the session plus the caller's current role", async () => {
    readMembershipRole.mockResolvedValue("admin");
    const access = await requireOrgAccess();
    expect(access).toMatchObject({ userId: "usr_1", orgId: "org_1", role: "admin" });
    // The membership read is scoped to the SESSION's org + user (explicit args, not RLS-only).
    expect(readMembershipRole).toHaveBeenCalledWith(expect.anything(), "org_1", "usr_1");
  });

  it("FAILS CLOSED — redirects to sign-in — for a removed member (no membership row)", async () => {
    readMembershipRole.mockResolvedValue(null);
    await expect(requireOrgAccess()).rejects.toThrow(`NEXT_REDIRECT:${LOGIN_URL}`);
  });

  it("inherits verifySession's redirect when there is no session", async () => {
    verifySession.mockRejectedValueOnce(new Error(`NEXT_REDIRECT:${LOGIN_URL}`));
    await expect(requireOrgAccess()).rejects.toThrow(`NEXT_REDIRECT:${LOGIN_URL}`);
    expect(readMembershipRole).not.toHaveBeenCalled(); // never reaches the membership read
  });
});
