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
import { verifySession } from "./session";
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

// The free-org cap counter. Defaults to 0 (under the cap) so the happy-path tests proceed.
const { countOwnedFreeOrgs } = vi.hoisted(() => ({ countOwnedFreeOrgs: vi.fn(async () => 0) }));
vi.mock("@webhook-co/db/org-lifecycle", () => ({ countOwnedFreeOrgs }));

// withTenantDb(fn) → fn(app); the app is unused by the mocked createOrgWithOwner / counter.
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
  // Default the cap counter to 0 (under the cap) so every test that isn't about the cap proceeds.
  countOwnedFreeOrgs.mockReset();
  countOwnedFreeOrgs.mockResolvedValue(0);
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

  it("is gated on the session — an unauthenticated caller never reaches the DB", async () => {
    // Creating an org doesn't require membership (the org doesn't exist yet), but it DOES require a valid
    // session. Mutation-check: dropping the verifySession() call would let this proceed to createOrgWithOwner.
    vi.mocked(verifySession).mockRejectedValueOnce(new Error("no session"));
    await expect(createTeamAction(form("Acme"))).rejects.toThrow(/no session/);
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

  it("denies creating another free org at the cap — before any create work", async () => {
    // A user already owning MAX_FREE_ORGS_PER_USER (2) free orgs cannot create a 3rd. Mutation-check:
    // the deny must short-circuit BEFORE createOrgWithOwner, so no org is minted and then rejected.
    countOwnedFreeOrgs.mockResolvedValueOnce(2);
    const res = await createTeamAction(form("Acme"));
    expect(res).toEqual({ ok: false, error: expect.stringContaining("free organizations") });
    expect(createOrgWithOwner).not.toHaveBeenCalled();
  });

  it("allows creation when under the cap", async () => {
    countOwnedFreeOrgs.mockResolvedValueOnce(1);
    createOrgWithOwner.mockResolvedValueOnce({ id: "org_new", slug: "acme-x" });
    await expect(createTeamAction(form("Acme"))).rejects.toThrow(/^REDIRECT:/);
    expect(createOrgWithOwner).toHaveBeenCalledTimes(1);
  });
});
