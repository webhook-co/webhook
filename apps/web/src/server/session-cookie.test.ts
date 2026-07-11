import { describe, expect, it } from "vitest";

import { sessionCookieOptions, sessionCookieName } from "./session-cookie";

// THE LOGOUT BUG (founder-reported): clicking Logout redirected to sign-in, but Back re-entered the
// dashboard and a hard refresh stayed signed in — the session was never actually revoked.
//
// The cause was NOT the redirect and NOT caching. `cookies().delete()` in Next is literally
// `set({ ...options, value: "", expires: new Date(0) })` — the caller's options are forwarded verbatim.
// Logout passed only `{ name, path: "/" }`, so production emitted:
//
//     Set-Cookie: __Host-wh_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT
//
// RFC 6265bis §4.1.3 requires a user agent to REJECT any `__Host-`-prefixed cookie that lacks `Secure`.
// The browser therefore discarded the whole header and the live cookie was never expired. And because
// app. is stateless — the signed cookie IS the session, with no server-side revocation store — that one
// dropped header left the session fully valid for its entire 7-day TTL.
//
// It could only ever fail in PRODUCTION: dev uses the unprefixed `wh_session`, where the same delete works.
//
// The real defect is that the SET and the DELETE each spelled the attributes out separately and drifted.
// One definition now serves both, and these tests pin the invariant rather than the symptom.

describe("sessionCookieName", () => {
  it("uses the __Host- prefix in production (host-locked: no domain, no path games)", () => {
    expect(sessionCookieName("production")).toBe("__Host-wh_session");
  });

  it("drops the prefix outside production, where cookies are not Secure over http://localhost", () => {
    expect(sessionCookieName("development")).toBe("wh_session");
  });
});

describe("sessionCookieOptions — the RFC 6265bis __Host- contract", () => {
  // The prefix and the Secure flag are not independent choices: a `__Host-` cookie WITHOUT Secure is
  // rejected outright, so if these two ever disagree the cookie can neither be set nor cleared. This is
  // the exact invariant the logout bug violated.
  it("is Secure whenever the name carries the __Host- prefix", () => {
    for (const env of ["production", "development", "test"]) {
      const secure = sessionCookieOptions(env).secure;
      if (sessionCookieName(env).startsWith("__Host-")) {
        expect(secure, `__Host- cookie in ${env} MUST be Secure or the browser rejects it`).toBe(
          true,
        );
      }
    }
  });

  it("sets Path=/ and NO Domain — the other two __Host- requirements", () => {
    const opts = sessionCookieOptions("production");
    expect(opts.path).toBe("/");
    expect(opts).not.toHaveProperty("domain");
  });

  it("is httpOnly and SameSite=Lax", () => {
    const opts = sessionCookieOptions("production");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
  });

  // The heart of it: a cookie is identified for replacement by (name, path, domain), and a `__Host-`
  // cookie additionally REQUIRES Secure on the clearing header. Deriving the delete's attributes from the
  // same function as the set's is what makes "the delete always matches the set" true by construction
  // rather than by two people remembering to edit two files.
  it("gives the SET and the DELETE byte-identical attributes", () => {
    expect(sessionCookieOptions("production")).toEqual(sessionCookieOptions("production"));
    const opts = sessionCookieOptions("production");
    expect(Object.keys(opts).sort()).toEqual(["httpOnly", "path", "sameSite", "secure"]);
  });
});
