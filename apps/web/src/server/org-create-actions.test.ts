import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => nav);

vi.mock("./session", () => ({
  verifySession: vi.fn(async () => ({ userId: "u_1", orgId: "o", user: { email: "d@e.t" } })),
}));
vi.mock("./env", () => ({ getAuditChainKey: async () => "AAAA" }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array() }));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

const { createOrgWithOwner, SlugTakenError, InvalidOrgSlugError } = vi.hoisted(() => {
  class SlugTakenError extends Error {}
  class InvalidOrgSlugError extends Error {}
  return { createOrgWithOwner: vi.fn(), SlugTakenError, InvalidOrgSlugError };
});
vi.mock("@webhook-co/db/orgs", () => ({ createOrgWithOwner, SlugTakenError, InvalidOrgSlugError }));

// withTenantDb(fn) → fn(app); the app is unused by the mocked createOrgWithOwner.
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { createTeamAction } from "./org-create-actions";

const form = (name?: string) => {
  const fd = new FormData();
  if (name !== undefined) fd.set("name", name);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT clear implementations, so a persistent mockRejectedValue from one test would leak
  // into the next (order-dependent). Reset the create mock's behaviour explicitly each test.
  createOrgWithOwner.mockReset();
});

describe("createTeamAction", () => {
  it("creates the org and redirects to the new dashboard on success", async () => {
    createOrgWithOwner.mockResolvedValueOnce({ id: "org_new", slug: "acme-a1b2c" });
    await expect(createTeamAction(form("Acme"))).rejects.toThrow(
      /^REDIRECT:\/org\/.+\/dashboard\?created=1$/,
    );
    expect(createOrgWithOwner).toHaveBeenCalledTimes(1);
    // the slug it was called with is what we redirect to
    const usedSlug = createOrgWithOwner.mock.calls[0]![1].slug;
    expect(nav.redirect).toHaveBeenCalledWith(`/org/${usedSlug}/dashboard?created=1`);
  });

  it("rejects an empty name without touching the DB", async () => {
    expect(await createTeamAction(form("   "))).toEqual({ ok: false, error: expect.any(String) });
    expect(createOrgWithOwner).not.toHaveBeenCalled();
  });

  it("RETRIES a slug collision with a fresh suffix, then succeeds", async () => {
    createOrgWithOwner
      .mockRejectedValueOnce(new SlugTakenError())
      .mockResolvedValueOnce({ id: "org_new", slug: "acme-second" });

    await expect(createTeamAction(form("Acme"))).rejects.toThrow(/^REDIRECT:/);

    expect(createOrgWithOwner).toHaveBeenCalledTimes(2);
    const first = createOrgWithOwner.mock.calls[0]![1].slug;
    const second = createOrgWithOwner.mock.calls[1]![1].slug;
    expect(first).not.toBe(second); // a genuinely different candidate, not the same one again
  });

  it("gives up after the bounded attempts with a friendly error, never looping forever", async () => {
    createOrgWithOwner.mockRejectedValue(new SlugTakenError());
    const res = await createTeamAction(form("Acme"));
    expect(res).toEqual({ ok: false, error: expect.stringContaining("free URL") });
    expect(createOrgWithOwner.mock.calls.length).toBeGreaterThan(1);
    expect(createOrgWithOwner.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("surfaces a non-collision fault as a generic error (never retried)", async () => {
    createOrgWithOwner.mockRejectedValueOnce(new Error("db down"));
    const res = await createTeamAction(form("Acme"));
    expect(res).toMatchObject({ ok: false });
    expect(createOrgWithOwner).toHaveBeenCalledTimes(1); // a db fault is not a collision — no retry
  });
});
