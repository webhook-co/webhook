import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeTicket, TEST_SECRET } = vi.hoisted(() => ({
  exchangeTicket: vi.fn(),
  TEST_SECRET: "callback-test-secret-aaaaaaaaaaaaaaaaaaaa",
}));
vi.mock("@/server/session-exchange", () => ({ exchangeTicket }));
vi.mock("@/server/env", () => ({
  getSessionSecret: async () => TEST_SECRET,
  getAuthBaseUrl: () => "https://auth.test",
}));

import { SESSION_COOKIE } from "@/server/session";
import { verifySessionToken } from "@/server/session-token";

import { GET } from "./route";

// Per-test `mockImplementationOnce` (rather than a persistent impl + reset) keeps vitest from
// mis-attributing the deliberately-failing exchange to the crypto-running success test.
function setCookieOf(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function cookieValue(setCookie: string, name: string): string {
  const part = setCookie.split(/;\s*/).find((p) => p.startsWith(`${name}=`)) ?? "";
  return decodeURIComponent(part.slice(name.length + 1));
}

describe("GET /auth/callback", () => {
  // Clear call history only (not the implementation — `mockReset` here mis-attributes the failing
  // exchange to the crypto-running success test; `mockClear` + per-call `Once` impls avoids that).
  beforeEach(() => exchangeTicket.mockClear());

  it("redeems the ticket, sets a valid host-only session cookie, and lands on / without the ticket", async () => {
    exchangeTicket.mockImplementationOnce(async () => ({
      userId: "usr_dana",
      orgId: "org_acme",
      user: { name: "Dana", email: "dana@acme.co", image: null },
    }));

    const res = await GET(new Request("https://app.test/auth/callback?ticket=sxt_abc"));

    expect(exchangeTicket).toHaveBeenCalledWith("sxt_abc");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    // lands on the dashboard with NO ticket in the URL (no history/referer leak)
    expect(res.headers.get("location")).toBe("https://app.test/");

    const setCookie = setCookieOf(res);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/SameSite=lax/i);

    const session = await verifySessionToken(cookieValue(setCookie, SESSION_COOKIE), TEST_SECRET);
    expect(session?.orgId).toBe("org_acme");
    expect(session?.userId).toBe("usr_dana");
  });

  it("redirects to login and sets no cookie when no ticket is present", async () => {
    const res = await GET(new Request("https://app.test/auth/callback"));
    expect(exchangeTicket).not.toHaveBeenCalled();
    expect(setCookieOf(res)).toBe("");
    expect(res.headers.get("location")).toContain("login");
  });

  it("redirects to login and sets no cookie when the exchange fails (invalid/expired ticket)", async () => {
    exchangeTicket.mockImplementationOnce(async () =>
      Promise.reject(new Error("session exchange failed: 401")),
    );
    const res = await GET(new Request("https://app.test/auth/callback?ticket=sxt_bad"));
    expect(setCookieOf(res)).toBe("");
    expect(res.headers.get("location")).toContain("login");
  });
});
