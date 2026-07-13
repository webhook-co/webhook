import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn(async () => ({
  userId: "u_1",
  orgId: "org_a",
  user: { name: "D", email: "d@acme.test", image: null },
}));
vi.mock("./session", () => ({
  verifySession: () => verifySession(),
  SESSION_COOKIE: "wh_session",
  SESSION_TTL_SECONDS: 604800,
}));

const listUserOrgs = vi.fn(async () => [
  { orgId: "org_a", name: "Personal", role: "owner" },
  { orgId: "org_b", name: "Acme Team", role: "member" },
]);
vi.mock("@webhook-co/db/orgs", () => ({ listUserOrgs: (...a: unknown[]) => listUserOrgs(...a) }));

const signSessionToken = vi.fn(async () => "signed.token");
const verifySessionToken = vi.fn(async () => ({
  userId: "u_1",
  orgId: "org_a",
  expiresAt: 10_000_000_000,
  user: { name: "D", email: "d@acme.test", image: null },
}));
vi.mock("./session-token", () => ({
  signSessionToken: (...a: unknown[]) => signSessionToken(...a),
  verifySessionToken: (...a: unknown[]) => verifySessionToken(...a),
}));

vi.mock("./session-cookie", () => ({ sessionCookieOptions: () => ({ httpOnly: true }) }));
vi.mock("./env", () => ({ getSessionSecret: async () => "secret" }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

const cookieStore = { set: vi.fn(), get: vi.fn(() => ({ value: "old.token" })) };
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { switchOrgAction } from "./org-switch";

function form(orgId: string): FormData {
  const fd = new FormData();
  fd.set("orgId", orgId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.get.mockReturnValue({ value: "old.token" });
  verifySessionToken.mockResolvedValue({
    userId: "u_1",
    orgId: "org_a",
    expiresAt: 10_000_000_000,
    user: { name: "D", email: "d@acme.test", image: null },
  });
  signSessionToken.mockResolvedValue("signed.token");
});

describe("switchOrgAction", () => {
  it("switches to an org the user BELONGS to and re-mints the session cookie", async () => {
    await expect(switchOrgAction(form("org_b"))).rejects.toThrow("NEXT_REDIRECT:/dashboard");

    // The re-signed session names the NEW org, with the same identity.
    expect(signSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1", orgId: "org_b" }),
      "secret",
      expect.any(Number),
    );
    expect(cookieStore.set).toHaveBeenCalledWith(
      "wh_session",
      "signed.token",
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it("REFUSES an org the user is not a member of — and re-mints nothing", async () => {
    // The whole authorization boundary: membership is re-read server-side from the user's own directory.
    // A crafted form must not be able to point the session at someone else's org.
    await expect(switchOrgAction(form("org_someone_elses"))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard?org=denied",
    );
    expect(signSessionToken).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("does NOT extend the session's lifetime — it carries the ORIGINAL expiry forward", async () => {
    // Re-signing with a fresh 7-day TTL would let a user keep a session alive forever by switching orgs.
    const now = 1_000_000_000;
    vi.setSystemTime(now);
    verifySessionToken.mockResolvedValueOnce({
      userId: "u_1",
      orgId: "org_a",
      expiresAt: Math.floor(now / 1000) + 60, // one minute left
      user: { name: "D", email: "d@acme.test", image: null },
    });

    await expect(switchOrgAction(form("org_b"))).rejects.toThrow("NEXT_REDIRECT:/dashboard");

    const ttl = signSessionToken.mock.calls[0][2] as number;
    expect(ttl).toBeLessThanOrEqual(60); // the REMAINING life, not a fresh week
    expect(ttl).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("is a no-op redirect when switching to the org you're already in", async () => {
    await expect(switchOrgAction(form("org_a"))).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(signSessionToken).not.toHaveBeenCalled();
  });

  it("rejects a missing orgId", async () => {
    const fd = new FormData();
    await expect(switchOrgAction(fd)).rejects.toThrow("NEXT_REDIRECT:/dashboard?org=denied");
    expect(signSessionToken).not.toHaveBeenCalled();
  });
});
