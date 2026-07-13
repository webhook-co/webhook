import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn(async () => ({
  userId: "u_1",
  orgId: "org_a",
  user: { name: "D", email: "d@acme.test", image: null },
}));
vi.mock("./session", () => ({ verifySession: () => verifySession() }));

const listUserOrgs = vi.fn();
vi.mock("@webhook-co/db/orgs", () => ({ listUserOrgs: (...a: unknown[]) => listUserOrgs(...a) }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { loadMyOrgs } from "./my-orgs";

const ORGS = [
  { orgId: "org_a", name: "Personal", role: "owner" },
  { orgId: "org_b", name: "Acme Team", role: "member" },
];

beforeEach(() => {
  vi.clearAllMocks();
  listUserOrgs.mockResolvedValue(ORGS);
});

describe("loadMyOrgs", () => {
  it("returns the user's orgs and which one the session is acting as", async () => {
    expect(await loadMyOrgs()).toEqual({ orgs: ORGS, currentOrgId: "org_a" });
    expect(listUserOrgs).toHaveBeenCalledWith(expect.anything(), "u_1");
  });

  it("still lists the orgs when the session's CURRENT org is one they were removed from", async () => {
    // The switcher has to keep working precisely then — it's how they get back to an org they do belong to.
    // (It reads the USER's memberships, so a dead current org doesn't blank the list.)
    verifySession.mockResolvedValueOnce({
      userId: "u_1",
      orgId: "org_gone",
      user: { name: "D", email: "d@acme.test", image: null },
    });
    listUserOrgs.mockResolvedValueOnce([ORGS[1]!]);
    expect(await loadMyOrgs()).toEqual({ orgs: [ORGS[1]], currentOrgId: "org_gone" });
  });

  it("degrades to 'no choice' rather than failing the whole shell when the read blips", async () => {
    // This runs on EVERY gated page. A transient DB fault must not 500 the entire dashboard for a sidebar
    // control — it just means no switcher this render.
    listUserOrgs.mockRejectedValueOnce(new Error("db down"));
    expect(await loadMyOrgs()).toEqual({ orgs: [], currentOrgId: "org_a" });
  });
});
