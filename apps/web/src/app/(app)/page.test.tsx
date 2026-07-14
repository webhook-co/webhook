import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMyOrgs = vi.fn();
vi.mock("@/server/my-orgs", () => ({ loadMyOrgs: () => loadMyOrgs() }));
// The landing page now also resolves the onboarding gate; default it to "done" so the existing routing tests
// exercise the routing, not onboarding (onboarding has its own tests).
const resolveOnboarding = vi.fn();
vi.mock("@/server/onboarding", () => ({ resolveOnboarding: () => resolveOnboarding() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import AppHome from "./page";
import { LOGOUT_URL } from "@/server/session";

const ALPHA = { orgId: "org_alpha", slug: "alpha", formerSlugs: [], name: "Alpha", role: "owner" };
const BETA = { orgId: "org_beta", slug: "beta", formerSlugs: [], name: "Beta", role: "member" };

const run = (myOrgs: unknown, sp: Record<string, string | string[] | undefined> = {}) => {
  loadMyOrgs.mockResolvedValue(myOrgs);
  resolveOnboarding.mockResolvedValue({ show: false });
  return AppHome({ searchParams: Promise.resolve(sp) });
};

beforeEach(() => vi.clearAllMocks());

// `/` is the post-login landing and the ONE survivor of the hard cutover. It has no org in the URL because
// there IS no org yet — the user just authenticated — so it resolves a DEFAULT and redirects. The cookie's
// orgId is only a hint; it is validated against the directory, never trusted to bypass it.
describe("AppHome (the default-org resolver)", () => {
  it("sends you to the org the cookie names, when you are still a member", async () => {
    await expect(run({ orgs: [ALPHA, BETA], currentOrgId: "org_beta" })).rejects.toThrow(
      "REDIRECT:/org/beta/dashboard",
    );
  });

  it("falls back to the first org when the cookie names one you have LEFT", async () => {
    // The hint is untrusted for this purpose: it may name an org the user was removed from. Validated against
    // the directory, it simply doesn't match, so we pick the first org they actually belong to.
    await expect(run({ orgs: [ALPHA, BETA], currentOrgId: "org_gone" })).rejects.toThrow(
      "REDIRECT:/org/alpha/dashboard",
    );
  });

  it("signs you out when you belong to NO org — never loops into a dashboard that can't exist", async () => {
    await expect(run({ orgs: [], currentOrgId: "org_gone" })).rejects.toThrow(
      `REDIRECT:${LOGOUT_URL}`,
    );
  });

  // An org-less session is signed out BEFORE the onboarding gate — onboarding can't help a user with no
  // personal org to rename, so the immediate-logout invariant must win over the onboarding redirect. Without
  // this ordering they'd be marched through a name screen and THEN logged out.
  it("signs out an org-less session ahead of onboarding — no onboard-then-logout detour", async () => {
    resolveOnboarding.mockResolvedValue({
      show: true,
      firstName: "Ada",
      lastName: "",
      needsOrgName: false,
      org: null,
    });
    await expect(run({ orgs: [], currentOrgId: "org_gone" })).rejects.toThrow(
      `REDIRECT:${LOGOUT_URL}`,
    );
  });

  it("forwards a known ?invite= flag (the invite-accept fallback lands here to keep its banner)", async () => {
    await expect(
      run({ orgs: [ALPHA], currentOrgId: "org_alpha" }, { invite: "accepted" }),
    ).rejects.toThrow("REDIRECT:/org/alpha/dashboard?invite=accepted");
  });

  // The onboarding gate: a fresh signup who has not finished onboarding is sent to /onboarding BEFORE any
  // dashboard. This is the one route where the gate can run (no org in the URL yet).
  it("redirects a not-yet-onboarded user to /onboarding, ahead of any dashboard", async () => {
    resolveOnboarding.mockResolvedValue({
      show: true,
      firstName: "Ada",
      lastName: "",
      needsOrgName: true,
      org: null,
    });

    await expect(AppHome({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "REDIRECT:/onboarding",
    );
  });

  it("DROPS an unrecognised ?invite= value — this is a redirect target, not an open passthrough", async () => {
    await expect(
      run({ orgs: [ALPHA], currentOrgId: "org_alpha" }, { invite: "evil" }),
    ).rejects.toThrow("REDIRECT:/org/alpha/dashboard");
  });
});
