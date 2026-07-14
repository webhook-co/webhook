import { personalOrgId } from "@webhook-co/db/orgs";
import { describe, expect, it } from "vitest";

import { classifyMembership, decideOnboarding } from "./onboarding-logic";

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

  // BACKSTOP for a broken migration order (0074 skipped while this code is live). A user created before the
  // feature shipped, still null on onboardedAt, is a pre-existing user — grandfather them, do not force the
  // screen. Without this they'd be prompted to rename their real, in-use org.
  it("grandfathers a user who predates the feature even with a null onboardedAt", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ createdAtIso: "2026-06-01T00:00:00.000Z", onboardedAtIso: null }),
      orgs: [personalOrg("u")],
    });
    expect(d.show).toBe(false);
  });

  // The other side of the boundary: a genuinely NEW signup is created after the epoch, so the backstop must
  // NOT skip them. (A new signup is always created after the feature shipped, so this direction is safe.)
  it("still onboards a fresh signup created after the feature epoch", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ createdAtIso: "2026-08-01T12:00:00.000Z", onboardedAtIso: null }),
      orgs: [personalOrg("u")],
    });
    expect(d.show).toBe(true);
  });

  // A malformed timestamp must not silently grandfather (which would WRONGLY skip a real new signup). NaN
  // fails the comparison, so we fall through to the normal decision — the safe direction.
  it("does not grandfather on an unparseable createdAt (falls through to normal onboarding)", () => {
    const d = decideOnboarding({
      userId: "u",
      state: state({ createdAtIso: "not-a-date", onboardedAtIso: null }),
      orgs: [personalOrg("u")],
    });
    expect(d.show).toBe(true);
  });
});

// The ONE classification the gate and the write share — so what the user is shown and what is enforced agree.
describe("classifyMembership", () => {
  it("classifies a sole personal-org member as fresh (not invited)", () => {
    const c = classifyMembership("u", [personalOrg("u")]);
    expect(c.invited).toBe(false);
    expect(c.personalOrg?.orgId).toBe(personalOrgId("u"));
    expect(c.personalId).toBe(personalOrgId("u"));
  });

  it("classifies a member of any non-personal org as invited", () => {
    const c = classifyMembership("u", [personalOrg("u"), teamOrg]);
    expect(c.invited).toBe(true);
  });

  it("reports a null personalOrg when the personal membership is absent (bootstrap blip)", () => {
    const c = classifyMembership("u", [teamOrg]);
    expect(c.invited).toBe(true);
    expect(c.personalOrg).toBeNull();
  });
});
