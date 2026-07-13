import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  // The real redirect() throws to halt rendering; mirror that so nothing can run past it.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("./env", () => ({
  getSessionSecret: vi.fn(async () => "s".repeat(32)),
  getAuthBaseUrl: vi.fn(() => "http://auth.test"),
}));

import { logout } from "./auth-actions";
import { sessionCookieOptions } from "./session-cookie";
import { SESSION_COOKIE, LOGOUT_URL } from "./session";

// There was NO test on logout at all — the layout test mocked the whole action away — which is how the
// clearing header shipped without `Secure` and silently failed to revoke anything in production.

describe("logout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the session cookie with the SAME attributes it was set with", async () => {
    await expect(logout()).rejects.toThrow("NEXT_REDIRECT");

    expect(cookieStore.delete).toHaveBeenCalledWith({
      name: SESSION_COOKIE,
      ...sessionCookieOptions(),
    });
  });

  // The regression, stated as the browser sees it. Next's `delete` forwards these options straight onto the
  // clearing `Set-Cookie`; a `__Host-` cookie whose clearing header lacks `Secure` is REJECTED by the user
  // agent (RFC 6265bis §4.1.3), so the live cookie is never expired. app. keeps no server-side session
  // store, so that dropped header left the session valid for its full 7-day TTL: Back and hard-refresh both
  // walked straight back into the dashboard.
  it("emits a clearing header a browser will actually accept — IN PRODUCTION, where it failed", async () => {
    // The bug was production-only, so asserting against the test env would prove nothing: there the cookie
    // is the unprefixed `wh_session` and even the broken delete worked. `sessionCookieOptions()` reads
    // NODE_ENV at CALL time, so stubbing it here exercises the exact code path that shipped broken.
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(logout()).rejects.toThrow("NEXT_REDIRECT");

      const opts = cookieStore.delete.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.secure, "a __Host- cookie cleared without Secure is rejected outright").toBe(
        true,
      );
      // The other two __Host- requirements a clearing header must satisfy.
      expect(opts.path).toBe("/");
      expect(opts).not.toHaveProperty("domain");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // It must go to auth.'s /logout, NOT /login. /login now RESUMES a live IdP session (that is single sign-on
  // working), so redirecting a logout there would sign the user straight back into the dashboard they just
  // left. Clearing app.'s cookie alone was never a logout: the IdP session could re-mint a new one.
  it("sends the user to auth.'s LOGOUT — not the login page, which would sign them back in", async () => {
    await expect(logout()).rejects.toThrow(`NEXT_REDIRECT:${LOGOUT_URL}`);
    expect(LOGOUT_URL).toMatch(/\/logout$/);
  });

  // Order matters: the cookie must be cleared on the very response that redirects. `redirect()` throws, so
  // a delete placed after it would never run at all.
  it("clears the cookie BEFORE redirecting, so the deletion rides the redirect response", async () => {
    await expect(logout()).rejects.toThrow("NEXT_REDIRECT");
    expect(cookieStore.delete).toHaveBeenCalled();
  });
});
