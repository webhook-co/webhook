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

// The identity state the recheck reads: a NOT-yet-onboarded user (onboardedAt null). Tests that exercise the
// replay short-circuit override read() to return an onboarded state.
const NOT_ONBOARDED = {
  firstName: null as string | null,
  lastName: null as string | null,
  name: "Dana",
  onboardedAtIso: null as string | null,
  createdAtIso: "2026-07-14T00:00:00.000Z",
};
const complete = vi.fn(async () => ({ completed: true }));
const read = vi.fn(async () => NOT_ONBOARDED);
const getOnboardingBinding = vi.fn(
  (): { read: typeof read; complete: typeof complete } | undefined => ({ read, complete }),
);
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

const teamOrg = {
  orgId: "org_team",
  slug: "acme",
  formerSlugs: [] as string[],
  name: "Acme",
  role: "member",
};

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({ userId: "usr_1" });
  getOnboardingBinding.mockReturnValue({ read, complete });
  read.mockResolvedValue(NOT_ONBOARDED);
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

describe("completeOnboardingAction — invited teammate (membership in a non-personal org)", () => {
  it("saves the name only and lands on the TEAM they joined — no rename, org fields ignored", async () => {
    // Invited = holds a membership in an org that is NOT their derived personal one. The action decides this
    // from the DIRECTORY, not from the presence of org fields, so a stray orgName in the body is ignored. And
    // they land on the team's dashboard, not `/` (which could resolve to their empty personal org).
    readUserOrgDirectory.mockResolvedValue([teamOrg]);
    await expect(
      completeOnboardingAction(form({ firstName: "Grace", lastName: "Hopper", orgName: "Evil" })),
    ).rejects.toThrow("NEXT_REDIRECT:/org/acme/dashboard");
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("usr_1", "Grace", "Hopper");
  });

  it("lands on the non-personal team even when the personal org is also present in the directory", async () => {
    readUserOrgDirectory.mockResolvedValue([
      { orgId: "org_personal", slug: "grace-x", formerSlugs: [], name: "grace", role: "owner" },
      teamOrg,
    ]);
    await expect(completeOnboardingAction(form({ firstName: "Grace" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard",
    );
    expect(renameOrg).not.toHaveBeenCalled();
  });
});

describe("completeOnboardingAction — the gate re-check (replay + empty org name)", () => {
  it("is a no-op for an already-onboarded user: bounces to `/` without renaming or re-stamping (replay guard)", async () => {
    // A double-submit or a stale/replayed POST from an onboarded user must NOT re-rename (a changed slug is
    // retired forever) or re-stamp. The action re-reads the gate and short-circuits.
    read.mockResolvedValue({ ...NOT_ONBOARDED, onboardedAtIso: "2026-07-14T00:00:00.000Z" });
    await expect(
      completeOnboardingAction(
        form({ firstName: "Ada", orgName: "Rename Me", orgSlug: "rename-me" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/");
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("requires a fresh signup to NAME their org — an empty field is rejected, not silently kept as the machine name", async () => {
    // The whole feature exists to replace the machine slug (dana-a3f19c). A fresh signup who cleared the
    // pre-filled name must be told to fill it; the server must not skip the rename and onboard them as-is.
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "", orgSlug: "" }),
    );
    expect(res).toMatchObject({ ok: false, field: "orgName" });
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the re-check read faults — never runs the destructive rename on an uncertain read", async () => {
    // A read fault means "couldn't tell if already onboarded". The rename is destructive and irreversible (a
    // changed slug is retired forever; a replay could revert a later edit), so we must NOT proceed on a guess.
    // Return an error and ask the user to retry — nothing is written.
    read.mockRejectedValueOnce(new Error("auth down"));
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" }),
    );
    expect(res).toMatchObject({ ok: false });
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(logActionError).toHaveBeenCalledWith(
      "onboarding.recheck_read_failed",
      expect.any(Error),
    );
  });

  it("does not hard-block on the org name when the form was invited-mode but the directory now says fresh (race)", async () => {
    // The form sent NO org fields (it rendered invited-mode), but the directory now shows only the personal
    // org — the team membership was revoked between render and submit. Onboard name-only rather than demand an
    // org-name field the user was never shown. `undefined` (absent) is distinct from `""` (cleared).
    await expect(completeOnboardingAction(form({ firstName: "Ada" }))).rejects.toThrow(
      "NEXT_REDIRECT:/",
    );
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("usr_1", "Ada", "");
    expect(logActionError).toHaveBeenCalledWith("onboarding.membership_race", expect.any(Error));
  });
});

describe("completeOnboardingAction — invite-status passthrough", () => {
  it("carries a whitelisted invite flag onto the invited teammate's landing", async () => {
    readUserOrgDirectory.mockResolvedValue([teamOrg]);
    await expect(
      completeOnboardingAction(form({ firstName: "Grace", invite: "accepted" })),
    ).rejects.toThrow("NEXT_REDIRECT:/org/acme/dashboard?invite=accepted");
  });

  it("ignores a non-whitelisted invite value (no open query passthrough)", async () => {
    readUserOrgDirectory.mockResolvedValue([teamOrg]);
    await expect(
      completeOnboardingAction(form({ firstName: "Grace", invite: "evil" })),
    ).rejects.toThrow("NEXT_REDIRECT:/org/acme/dashboard");
  });
});

describe("completeOnboardingAction — the session gate", () => {
  it("refuses when the session cannot be verified — no rename, no stamp", async () => {
    // Mutation-check: the action's very first line is verifySession(). If that gate were dropped, a valid
    // FormData would sail through to the identity write; this asserts a rejected session stops everything.
    verifySession.mockRejectedValueOnce(new Error("no session"));
    await expect(
      completeOnboardingAction(form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" })),
    ).rejects.toThrow("no session");
    expect(renameOrg).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
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

  it("rejects an over-long first name, attributed to the first-name field", async () => {
    const res = await completeOnboardingAction(form({ firstName: "a".repeat(81) }));
    expect(res).toMatchObject({ ok: false, field: "firstName" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("attributes an over-long LAST name to the last-name field (not firstName)", async () => {
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", lastName: "b".repeat(81) }),
    );
    expect(res).toMatchObject({ ok: false, field: "lastName" });
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

  it("maps a RenameForbiddenError (server-side role gate) to a message and NEVER stamps the gate", async () => {
    // renameOrg re-checks owner/admin regardless of the role the action passed. If its own gate refuses, the
    // onboarding stamp must not happen — the same "gate stays closed on a failed rename" invariant, but via
    // the authorization path rather than the slug path.
    renameOrg.mockRejectedValueOnce(new RenameForbiddenError());
    const res = await completeOnboardingAction(
      form({ firstName: "Ada", orgName: "Acme", orgSlug: "acme" }),
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/rename that organization/i);
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
