import { beforeEach, describe, expect, it, vi } from "vitest";

// completeOnboardingAction is the onboarding GATE WRITE path: verify the session, rename the user's own
// personal org (fresh signup only), then stamp `onboardedAt` LAST. The write ORDER is the correctness
// argument — the stamp is the gate, so a mid-way failure must leave the user "not onboarded" with the org
// already renamed (a trivial retry), never stranded past onboarding with the work half-done. None of that is
// exercised by the UI tests (they mock the action), so it is pinned here.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const verifySession = vi.fn(async () => ({ userId: "usr_1" }));
vi.mock("./session", () => ({ verifySession: () => verifySession() }));

const complete = vi.fn(async () => ({ completed: true }));
const getOnboardingBinding = vi.fn((): { complete: typeof complete } | undefined => ({ complete }));
vi.mock("./env", () => ({
  getOnboardingBinding: () => getOnboardingBinding(),
  getAuditChainKey: async () => "AA".repeat(32),
}));

const readUserOrgDirectory = vi.fn(
  async (): Promise<
    ReadonlyArray<{
      orgId: string;
      slug: string;
      formerSlugs: string[];
      name: string;
      role: string;
    }>
  > => [
    { orgId: "org_personal", slug: "dana-a3f19c", formerSlugs: [], name: "dana", role: "owner" },
  ],
);
vi.mock("./org-directory", () => ({ readUserOrgDirectory: () => readUserOrgDirectory() }));

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
// personalOrgId is DERIVED from the verified userId — never client-supplied. The mock returns the fixed id
// the directory above reports as the user's own org, so `mine` resolves and the rename targets it.
vi.mock("@webhook-co/db/orgs", () => ({
  renameOrg: (...a: unknown[]) => renameOrg(...a),
  personalOrgId: (userId: string) => (userId === "usr_1" ? "org_personal" : `org_${userId}`),
  SlugTakenError,
  InvalidOrgSlugError,
  RenameForbiddenError,
}));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));
const logActionError = vi.fn();
vi.mock("./action-log", () => ({ logActionError: (...a: unknown[]) => logActionError(...a) }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));

import { completeOnboardingAction } from "./onboarding-actions";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({ userId: "usr_1" });
  getOnboardingBinding.mockReturnValue({ complete });
  complete.mockResolvedValue({ completed: true });
  readUserOrgDirectory.mockResolvedValue([
    { orgId: "org_personal", slug: "dana-a3f19c", formerSlugs: [], name: "dana", role: "owner" },
  ]);
});

describe("completeOnboardingAction — fresh signup (org fields present)", () => {
  it("renames the user's OWN personal org, THEN stamps onboardedAt, THEN lands on the org dashboard", async () => {
    renameOrg.mockResolvedValueOnce({ id: "org_personal", slug: "acme", name: "Acme Inc" });

    await expect(
      completeOnboardingAction(
        form({ firstName: "Ada", lastName: "Lovelace", orgName: "Acme Inc", orgSlug: "acme" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/org/acme/dashboard");

    // renameOrg(app, input) — the input (SECOND arg) targets the DERIVED personal org, with the caller's own
    // role read from the directory (never trusted from the client) and the new name/slug.
    expect(renameOrg.mock.calls[0]![1]).toMatchObject({
      orgId: "org_personal",
      actorRole: "owner",
      actorId: "usr_1",
      name: "Acme Inc",
      slug: "acme",
    });
    expect(complete).toHaveBeenCalledWith("usr_1", "Ada", "Lovelace");

    // The load-bearing invariant: the gate stamp happens AFTER the work it gates on. If this order ever flips,
    // a rename failure would strand the user past onboarding.
    expect(renameOrg.mock.invocationCallOrder[0]!).toBeLessThan(
      complete.mock.invocationCallOrder[0]!,
    );
  });

  it("omits the slug from the rename when it is unchanged (name-only)", async () => {
    renameOrg.mockResolvedValueOnce({ id: "org_personal", slug: "dana-a3f19c", name: "Dana" });
    await expect(
      completeOnboardingAction(
        form({ firstName: "Dana", orgName: "Dana", orgSlug: "dana-a3f19c" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/org/dana-a3f19c/dashboard");
    expect(renameOrg.mock.calls[0]![1].slug).toBeUndefined();
  });
});

describe("completeOnboardingAction — invited teammate (no org fields)", () => {
  it("saves the name only: no rename, and lands on `/` (the default-org resolver)", async () => {
    await expect(
      completeOnboardingAction(form({ firstName: "Grace", lastName: "Hopper" })),
    ).rejects.toThrow("NEXT_REDIRECT:/");
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("usr_1", "Grace", "Hopper");
  });
});

describe("completeOnboardingAction — validation and failure mapping", () => {
  it("rejects an empty first name BEFORE any binding lookup or write", async () => {
    const res = await completeOnboardingAction(form({ firstName: "  ", lastName: "X" }));
    expect(res).toMatchObject({ ok: false, field: "firstName" });
    expect(getOnboardingBinding).not.toHaveBeenCalled();
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an over-long name before any write", async () => {
    const res = await completeOnboardingAction(form({ firstName: "a".repeat(81) }));
    expect(res).toMatchObject({ ok: false, field: "firstName" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the binding is unbound — no identity write can be pretended", async () => {
    getOnboardingBinding.mockReturnValueOnce(undefined);
    const res = await completeOnboardingAction(form({ firstName: "Ada" }));
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/unavailable/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("maps a taken slug to an inline error and NEVER stamps the gate (complete not called)", async () => {
    renameOrg.mockRejectedValueOnce(new SlugTakenError());
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" }),
    );
    expect(res).toMatchObject({ ok: false, field: "orgSlug" });
    // The gate must stay closed: a failed rename means the user is still "not onboarded" and simply re-tries.
    expect(complete).not.toHaveBeenCalled();
  });

  it("maps an InvalidOrgSlugError from the DB to a friendly slug error, gate still closed", async () => {
    renameOrg.mockRejectedValueOnce(new InvalidOrgSlugError("format"));
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" }),
    );
    expect(res).toMatchObject({ ok: false, field: "orgSlug" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a malformed slug locally, before the DB is touched", async () => {
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "no" }),
    );
    expect(res).toMatchObject({ ok: false, field: "orgSlug" });
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns an error (not a redirect) when the stamp itself fails AFTER a successful rename", async () => {
    renameOrg.mockResolvedValueOnce({ id: "org_personal", slug: "acme", name: "Acme" });
    complete.mockRejectedValueOnce(new Error("auth down"));
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" }),
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/finish setting up/i);
    // Rename already happened; the user is still not onboarded, so their next login re-shows the screen with
    // the org already named — the retry is trivial. That is the whole point of stamping last.
    expect(renameOrg).toHaveBeenCalledOnce();
  });

  it("still saves the name when the personal org is missing (bootstrap blip), landing on `/`", async () => {
    readUserOrgDirectory.mockResolvedValueOnce([]); // no personal org to rename
    await expect(
      completeOnboardingAction(form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" })),
    ).rejects.toThrow("NEXT_REDIRECT:/");
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("usr_1", "Ada", "");
    expect(logActionError).toHaveBeenCalledWith("onboarding.no_personal_org", expect.any(Error));
  });
});
