import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMyOrgs = vi.fn();
vi.mock("@/server/my-orgs", () => ({ loadMyOrgs: () => loadMyOrgs() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

import LegacyDashboardRedirect from "./page";
import { LOGOUT_URL } from "@/server/session";

const ALPHA = { orgId: "org_alpha", slug: "alpha", formerSlugs: [], name: "Alpha", role: "owner" };
const BETA = { orgId: "org_beta", slug: "beta", formerSlugs: [], name: "Beta", role: "member" };

const run = (
  legacy: string[],
  myOrgs: unknown = { orgs: [ALPHA, BETA], currentOrgId: "org_beta" },
  sp: Record<string, string | string[] | undefined> = {},
) => {
  loadMyOrgs.mockResolvedValue(myOrgs);
  return LegacyDashboardRedirect({
    params: Promise.resolve({ legacy }),
    searchParams: Promise.resolve(sp),
  });
};

beforeEach(() => vi.clearAllMocks());

// The catch-all that keeps old dashboard bookmarks alive after the URL move (ADR-0117 hard cutover). It
// forwards a KNOWN old path to the caller's DEFAULT org, preserving the deep path + query — the same
// default-org resolution `/` does, never a guessed acting-org write.
describe("LegacyDashboardRedirect", () => {
  it("forwards a known legacy path to the default org, preserving path + query", async () => {
    await expect(
      run(
        ["endpoints", "ep_1"],
        { orgs: [ALPHA, BETA], currentOrgId: "org_beta" },
        { tab: "events" },
      ),
    ).rejects.toThrow("REDIRECT:/org/beta/endpoints/ep_1?tab=events");
  });

  it("resolves the default org exactly like `/` — the cookie hint picks, the directory validates", async () => {
    // Cookie names an org the user has left → fall back to the first org they actually belong to.
    await expect(
      run(["billing"], { orgs: [ALPHA, BETA], currentOrgId: "org_gone" }),
    ).rejects.toThrow("REDIRECT:/org/alpha/billing");
  });

  it("404s an UNKNOWN path — a typo/probe is not a moved bookmark, so it stays a clean 404", async () => {
    await expect(run(["totally-not-a-page"])).rejects.toThrow("NOT_FOUND");
    // and it never even consults the directory
    expect(loadMyOrgs).not.toHaveBeenCalled();
  });

  it("signs you out when you belong to NO org — never loops into a dashboard that can't exist", async () => {
    await expect(run(["endpoints"], { orgs: [], currentOrgId: "org_gone" })).rejects.toThrow(
      `REDIRECT:${LOGOUT_URL}`,
    );
  });
});
