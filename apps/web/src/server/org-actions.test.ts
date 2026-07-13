import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteOrganization erases the org and this session's tenancy, then signs out. The redirect MUST go to
// auth.'s /logout (LOGOUT_URL), not /login: /login now resumes a live IdP session, so a regression to it
// would bounce the just-deleted user straight back into a dashboard for an org that no longer exists. This
// is a security-critical invariant with no UI test behind it (UI tests mock the action).

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// deleteOrganization now gates through requireOrgAccess (membership + role), not verifySession + isOrgOwner.
const requireOrgAccess = vi.fn(async () => ({
  userId: "usr_1",
  orgId: "org_1",
  slug: "acme",
  role: "owner" as const,
  user: { name: "Dana", email: "dana@e.test", image: null },
}));
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const deleteOrgWithAudit = vi.fn(async () => ({ orgId: "org_1", deletedAt: "now" }));
vi.mock("@webhook-co/db/org-lifecycle", () => ({
  deleteOrgWithAudit: (...a: unknown[]) => deleteOrgWithAudit(...a),
}));
const renameOrg = vi.fn();
const { SlugTakenError, InvalidOrgSlugError, RenameForbiddenError } = vi.hoisted(() => {
  class SlugTakenError extends Error {}
  class InvalidOrgSlugError extends Error {
    constructor(public reason = "format") {
      super();
    }
  }
  class RenameForbiddenError extends Error {}
  return { SlugTakenError, InvalidOrgSlugError, RenameForbiddenError };
});
vi.mock("@webhook-co/db/orgs", () => ({
  renameOrg: (...a: unknown[]) => renameOrg(...a),
  SlugTakenError,
  InvalidOrgSlugError,
  RenameForbiddenError,
}));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));
vi.mock("./db", () => ({
  getTenantDb: async () => ({ end: async () => {} }),
  withTenantDb: (fn: (app: unknown) => unknown) => fn({}),
}));
vi.mock("./env", () => ({
  getAuditChainKey: async () => "AA".repeat(32),
  getAuthBaseUrl: () => "https://auth.test",
  getSessionSecret: async () => "s".repeat(32),
}));
vi.mock("@webhook-co/shared", async (orig) => ({
  ...(await orig<typeof import("@webhook-co/shared")>()),
  userActor: (id: string) => ({ kind: "user", id }),
}));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));

import { deleteOrganization, renameOrgAction } from "./org-actions";
import { sessionCookieOptions } from "./session-cookie";
import { LOGOUT_URL, LOGIN_URL, SESSION_COOKIE } from "./session";

function form(confirm: string): FormData {
  const fd = new FormData();
  fd.set("confirm", confirm);
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("deleteOrganization", () => {
  it("clears the session cookie and redirects to LOGOUT — never LOGIN", async () => {
    await expect(deleteOrganization("acme", form("DELETE"))).rejects.toThrow(
      `NEXT_REDIRECT:${LOGOUT_URL}`,
    );

    expect(deleteOrgWithAudit).toHaveBeenCalledOnce();
    expect(cookieStore.delete).toHaveBeenCalledWith({
      name: SESSION_COOKIE,
      ...sessionCookieOptions(),
    });
    // The invariant, stated as its own assertion: a deleted org must not re-authenticate.
    expect(LOGOUT_URL).not.toBe(LOGIN_URL);
    expect(LOGOUT_URL).toMatch(/\/logout$/);
  });

  it("refuses without the typed DELETE acknowledgement, and never touches the org or the cookie", async () => {
    await expect(deleteOrganization("acme", form("nope"))).rejects.toThrow(/not confirmed/);
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("refuses a non-owner (role from requireOrgAccess) and does not delete or sign out", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "usr_1",
      orgId: "org_1",
      role: "member" as const,
      user: { name: "Dana", email: "dana@e.test", image: null },
    });
    await expect(deleteOrganization("acme", form("DELETE"))).rejects.toThrow(
      /only an organization owner/,
    );
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});

const renameForm = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("renameOrgAction", () => {
  it("renames and redirects to the (new) canonical settings URL", async () => {
    renameOrg.mockResolvedValueOnce({ id: "org_1", slug: "acme-new", name: "Acme" });
    await expect(renameOrgAction("acme", renameForm({ slug: "acme-new" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme-new/settings?renamed=1",
    );
    // renameOrg(app, input) — the input is the SECOND arg.
    expect(renameOrg.mock.calls[0]![1]).toMatchObject({
      orgId: "org_1",
      actorRole: "owner",
      slug: "acme-new",
    });
  });

  it("rejects a malformed slug BEFORE the DB, with a friendly field error", async () => {
    const res = await renameOrgAction("acme", renameForm({ slug: "no" }));
    expect(res).toMatchObject({ ok: false, field: "slug" });
    expect(renameOrg).not.toHaveBeenCalled();
  });

  it("rejects a reserved slug before the DB", async () => {
    const res = await renameOrgAction("acme", renameForm({ slug: "billing" }));
    expect(res).toMatchObject({ ok: false, field: "slug" });
    expect(renameOrg).not.toHaveBeenCalled();
  });

  it("maps a SlugTakenError from the DB to an inline 'URL taken' error", async () => {
    renameOrg.mockRejectedValueOnce(new SlugTakenError());
    const res = await renameOrgAction("acme", renameForm({ slug: "acme-taken" }));
    expect(res).toMatchObject({ ok: false, field: "slug" });
    expect((res as { error: string }).error).toMatch(/taken/i);
  });

  it("maps a RenameForbiddenError (server-side role gate) to a message", async () => {
    renameOrg.mockRejectedValueOnce(new RenameForbiddenError());
    const res = await renameOrgAction("acme", renameForm({ name: "New" }));
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/owner or admin/i);
  });

  it("does NOT pass the slug to renameOrg when it is unchanged (name-only rename)", async () => {
    renameOrg.mockResolvedValueOnce({ id: "org_1", slug: "acme", name: "Renamed" });
    await expect(
      renameOrgAction("acme", renameForm({ name: "Renamed", slug: "acme" })),
    ).rejects.toThrow("NEXT_REDIRECT:/org/acme/settings?renamed=1");
    expect(renameOrg.mock.calls[0]![1].slug).toBeUndefined();
  });
});
