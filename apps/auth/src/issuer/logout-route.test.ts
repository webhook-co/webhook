import { describe, expect, it, vi } from "vitest";

import { handleLogout, type LogoutRouteDeps } from "./logout-route";

// GET /logout — the piece that was missing entirely. app. could only ever clear its OWN cookie, so the
// auth. (Better Auth) session survived every "logout": `GET /session/handoff` would read the still-valid
// auth cookie and mint a brand-new 7-day dashboard session with ZERO credentials, and the login page would
// silently re-authenticate. Signing out has to end the session at the IdP, not just at the app.

const SIGNED_OUT = () =>
  new Response(null, {
    status: 200,
    // What Better Auth's signOut returns: the clearing Set-Cookie for its own host-only session cookie.
    headers: {
      "set-cookie": "__Secure-better-auth.session_token=; Path=/; Max-Age=0; Secure; HttpOnly",
    },
  });

function deps(over: Partial<LogoutRouteDeps> = {}): LogoutRouteDeps {
  return {
    signOut: vi.fn(async () => SIGNED_OUT()),
    loginUrl: () => "/login",
    ...over,
  };
}

/** A top-level navigation from app. — the real logout path (same registrable site, different origin). */
function req(headers: Record<string, string> = {}): Request {
  return new Request("https://auth.webhook.co/logout", {
    headers: { "sec-fetch-site": "same-site", ...headers },
  });
}

describe("handleLogout", () => {
  it("destroys the session at the IdP, then redirects to sign-in", async () => {
    const d = deps();
    const res = await handleLogout(d, req());

    expect(d.signOut).toHaveBeenCalledOnce();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("forwards the IdP's clearing Set-Cookie onto the redirect, so the cookie actually dies", async () => {
    const res = await handleLogout(deps(), req());
    const cookies = res.headers.getSetCookie();

    expect(cookies.some((c) => c.startsWith("__Secure-better-auth.session_token=;"))).toBe(true);
  });

  // Belt and braces on top of the Set-Cookie: `Clear-Site-Data: "cookies"` applies to the whole registrable
  // domain, so it also takes out app.'s `__Host-wh_session` — the exact cookie whose clearing header was
  // silently rejected before. Even if signOut's header were dropped for any reason, the browser still ends
  // up with no webhook.co session cookies.
  it("sends Clear-Site-Data so no webhook.co session cookie can survive", async () => {
    const res = await handleLogout(deps(), req());
    expect(res.headers.get("clear-site-data")).toContain('"cookies"');
  });

  it("is never cached — a cached logout would be a no-op on the next visit", async () => {
    const res = await handleLogout(deps(), req());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // A GET that mutates state is CSRF-able: evil.com can top-level-navigate a victim to /logout and the
  // SameSite=Lax session cookie WOULD ride along, force-logging them out. Impact is nuisance, not
  // compromise — but it costs one header to refuse. app.->auth. is `same-site`, an address-bar visit is
  // `none`, and a third-party site is `cross-site`.
  it("refuses a cross-site forced logout (CSRF) without touching the session", async () => {
    const d = deps();
    const res = await handleLogout(d, req({ "sec-fetch-site": "cross-site" }));

    expect(res.status).toBe(403);
    expect(d.signOut).not.toHaveBeenCalled();
  });

  it("allows a same-origin logout and a direct address-bar visit", async () => {
    for (const site of ["same-origin", "none"]) {
      const d = deps();
      const res = await handleLogout(d, req({ "sec-fetch-site": site }));
      expect(res.status, site).toBe(302);
      expect(d.signOut, site).toHaveBeenCalledOnce();
    }
  });

  // A browser too old to send Sec-Fetch-Site must still be able to log out. Forced logout is a nuisance;
  // being UNABLE to log out is a security failure. So the absent header proceeds.
  it("still logs out when the browser sends no Sec-Fetch-Site", async () => {
    const d = deps();
    const res = await handleLogout(d, new Request("https://auth.webhook.co/logout"));

    expect(res.status).toBe(302);
    expect(d.signOut).toHaveBeenCalledOnce();
  });

  // If the IdP call fails we must NOT strand the user in a signed-in state and pretend otherwise. The
  // redirect still carries Clear-Site-Data, so the browser drops its cookies regardless; we log loudly
  // because the server-side session row may still be live.
  it("still clears the browser and redirects when the IdP sign-out throws", async () => {
    const log = vi.fn();
    const res = await handleLogout(
      deps({
        signOut: vi.fn(async () => {
          throw new Error("db down");
        }),
        log,
      }),
      req(),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("clear-site-data")).toContain('"cookies"');
    expect(log).toHaveBeenCalledWith("logout.sign_out_failed", expect.anything());
  });

  it("is idempotent — logging out with no session still lands on sign-in", async () => {
    const res = await handleLogout(
      deps({ signOut: vi.fn(async () => new Response(null, { status: 200 })) }),
      req(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
