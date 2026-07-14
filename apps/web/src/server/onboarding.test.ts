import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn();
const getOnboardingBinding = vi.fn();
const readUserOrgDirectory = vi.fn();
vi.mock("./session", () => ({ verifySession: () => verifySession() }));
vi.mock("./env", () => ({ getOnboardingBinding: () => getOnboardingBinding() }));
vi.mock("./org-directory", () => ({
  readUserOrgDirectory: (...a: unknown[]) => readUserOrgDirectory(...a),
}));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

import { resolveOnboarding } from "./onboarding";

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({ userId: "usr_1", user: { name: "Ada", email: "a@b.co" } });
  readUserOrgDirectory.mockResolvedValue([]);
});

describe("resolveOnboarding — fails OPEN", () => {
  // Onboarding is a nicety; never letting someone reach their dashboard is a failure. So every degraded path
  // must resolve to "don't show", not to a trap.
  it("does not show onboarding when the binding is unbound (dev / pre-provision)", async () => {
    getOnboardingBinding.mockReturnValue(undefined);
    expect((await resolveOnboarding()).show).toBe(false);
  });

  it("does not show onboarding when the identity read throws", async () => {
    getOnboardingBinding.mockReturnValue({
      read: vi.fn().mockRejectedValue(new Error("auth down")),
    });
    expect((await resolveOnboarding()).show).toBe(false);
  });

  it("shows onboarding for a not-yet-onboarded fresh signup", async () => {
    // A user whose only org is their personal one (see decideOnboarding tests for the full matrix).
    const { personalOrgId } = await import("@webhook-co/db/orgs");
    readUserOrgDirectory.mockResolvedValue([
      { orgId: personalOrgId("usr_1"), slug: "ada-x", name: "Ada", role: "owner", formerSlugs: [] },
    ]);
    getOnboardingBinding.mockReturnValue({
      read: vi.fn().mockResolvedValue({
        firstName: "Ada",
        lastName: "Lovelace",
        name: "Ada Lovelace",
        onboardedAtIso: null,
        createdAtIso: "2026-07-14T00:00:00.000Z",
      }),
    });

    const d = await resolveOnboarding();
    expect(d.show).toBe(true);
  });
});
