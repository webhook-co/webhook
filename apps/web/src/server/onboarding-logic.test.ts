import { personalOrgId } from "@webhook-co/db/orgs";
import { describe, expect, it } from "vitest";

import { decideOnboarding } from "./onboarding-logic";

const state = (over: Partial<Parameters<typeof decideOnboarding>[0]["state"] & object> = {}) => ({
  firstName: null,
  lastName: null,
  name: "Ada Lovelace",
  onboardedAtIso: null,
  createdAtIso: "2026-07-14T00:00:00.000Z",
  ...over,
});

const personalOrg = (userId: string) => ({
  orgId: personalOrgId(userId), // the REAL derivation — the invite-skip depends on it matching
  slug: "ada-a3f19c",
  name: "Ada Lovelace",
  role: "owner" as const,
  formerSlugs: [] as string[],
});

const teamOrg = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  slug: "acme",
  name: "Acme",
  role: "member" as const,
  formerSlugs: [] as string[],
};

describe("decideOnboarding", () => {
  it("does not show onboarding once onboardedAt is set", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ onboardedAtIso: "2026-07-14T00:00:00.000Z" }),
      orgs: [personalOrg("u")],
    });
    expect(d.show).toBe(false);
  });

  // A FRESH signup: sole membership is their personal org → show onboarding AND let them name it.
  it("shows onboarding and offers to name the org for a fresh signup", () => {
    const d = decideOnboarding({ userId: "u", state: state(), orgs: [personalOrg("u")] });

    expect(d).toMatchObject({ show: true, needsOrgName: true });
    if (!d.show) throw new Error("unreachable");
    expect(d.org?.slug).toBe("ada-a3f19c");
  });

  // An INVITED teammate already belongs to a real, named org → collect their name but do NOT ask them to name
  // an org. Asking would be nonsense and would tempt them to rename a team that is not theirs.
  it("does NOT ask an invited teammate to name an org", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state(),
      orgs: [personalOrg("u"), teamOrg],
    });

    expect(d).toMatchObject({ show: true, needsOrgName: false, org: null });
  });

  it("treats a user with ONLY a team org (bootstrap blipped) as invited — no org step", () => {
    const d = decideOnboarding({ userId: "u", state: state(), orgs: [teamOrg] });
    expect(d).toMatchObject({ show: true, needsOrgName: false });
  });

  it("prefers the provider-mapped first/last name", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ firstName: "Grace", lastName: "Hopper" }),
      orgs: [personalOrg("u")],
    });
    if (!d.show) throw new Error("unreachable");
    expect(d.firstName).toBe("Grace");
    expect(d.lastName).toBe("Hopper");
  });

  it("splits the composite name for a magic-link user with no provider fields", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ name: "Ada Lovelace" }),
      orgs: [personalOrg("u")],
    });
    if (!d.show) throw new Error("unreachable");
    expect(d.firstName).toBe("Ada");
    expect(d.lastName).toBe("Lovelace");
  });

  // Fail OPEN: a missing identity read (auth unreachable) must send the user to the dashboard, never trap
  // them in an onboarding loop.
  it("skips onboarding when the identity read is unavailable", () => {
    expect(decideOnboarding({ userId: "u", state: null, orgs: [] }).show).toBe(false);
  });
});
