import { describe, expect, it, vi } from "vitest";

const setInviteCookie = vi.fn(async () => {});
vi.mock("@/server/invite-cookie", () => ({
  setInviteCookie: (...a: unknown[]) => setInviteCookie(...a),
}));
vi.mock("@/server/session", () => ({
  loginUrlWithReturn: (p: string) => `https://auth.test/login?redirect=HANDOFF(${p})`,
}));

import { GET } from "./route";

describe("GET /invite/start", () => {
  it("stashes {org, token} in the cookie and bounces to login returning to /invite/accept (no token in the URL)", async () => {
    const res = await GET(new Request("https://app.test/invite/start?org=X&token=SECRET"));
    expect(setInviteCookie).toHaveBeenCalledWith({ org: "X", token: "SECRET" });
    const loc = res.headers.get("location") ?? "";
    expect(loc).toBe("https://auth.test/login?redirect=HANDOFF(/invite/accept?org=X)");
    expect(loc).not.toContain("SECRET"); // token rides the cookie, never the auth-origin URL
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("with no token: sets no cookie, still bounces to login", async () => {
    setInviteCookie.mockClear();
    const res = await GET(new Request("https://app.test/invite/start?org=X"));
    expect(setInviteCookie).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(
      "https://auth.test/login?redirect=HANDOFF(/invite/accept?org=X)",
    );
  });
});
