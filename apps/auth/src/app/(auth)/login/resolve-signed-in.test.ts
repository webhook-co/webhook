import { beforeEach, describe, expect, it, vi } from "vitest";

// The signed-in gate that lets /login RESUME an existing session instead of asking again. It must stay
// aligned with GET /logout: a deleted session row reads as absent immediately (cookieCache is off), which
// is the whole reason logout and resume can coexist. page.test.tsx mocks this module wholesale, so without
// this file the gate itself — including the pool-close-in-finally — is never exercised.

const getSession = vi.fn();
const close = vi.fn(async () => {});
const makeAuth = vi.fn(async () => ({ getSession, close }));
const waitUntil = vi.fn();
const readAuthEnv = vi.fn((e: unknown) => e);
let currentHeaders = new Headers();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { AUTH: 1 }, ctx: { waitUntil } })),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => currentHeaders) }));
vi.mock("@/runtime/auth", () => ({ makeAuth: (...args: unknown[]) => makeAuth(...args) }));
vi.mock("@/runtime/env", () => ({ readAuthEnv: (...args: unknown[]) => readAuthEnv(...args) }));

import { hasSessionCookie, isSignedIn } from "./resolve-signed-in";

beforeEach(() => {
  vi.clearAllMocks();
  currentHeaders = new Headers();
});

/** A signed-in browser always carries the IdP session cookie — the tests that mean "signed in" must say so. */
const SIGNED_IN = () => new Headers({ cookie: "__Secure-better-auth.session_token=abc" });

describe("isSignedIn", () => {
  it("is true when the IdP has a live session", async () => {
    currentHeaders = SIGNED_IN();
    getSession.mockResolvedValueOnce({ userId: "usr_1" });
    expect(await isSignedIn()).toBe(true);
  });

  it("is false when the cookie is present but the session row is gone (revoked)", async () => {
    currentHeaders = SIGNED_IN();
    getSession.mockResolvedValueOnce(null);
    expect(await isSignedIn()).toBe(false);
  });

  // The hot path after EVERY logout: we 302 to /login, and /login asked the database whether a user we just
  // signed out is signed in. Answering that cost a full makeAuth() — 7 Secrets Store reads, a pg Pool over
  // Hyperdrive, and a betterAuth() construction — to learn what the absent cookie already told us for free.
  // No cookie => no session, with certainty: the session is only ever read FROM the cookie.
  it("short-circuits with NO database work when the request carries no session cookie", async () => {
    currentHeaders = new Headers();

    expect(await isSignedIn()).toBe(false);

    expect(makeAuth).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  // A cookie header that exists but names other cookies (theme, consent) is still "no session".
  it("short-circuits when a cookie header exists but carries no session cookie", async () => {
    currentHeaders = new Headers({ cookie: "wh_theme=dark; other=1" });

    expect(await isSignedIn()).toBe(false);

    expect(makeAuth).not.toHaveBeenCalled();
  });

  // Dev serves the cookie unprefixed (no Secure prefix), so the check must not be pinned to the prod name.
  it("still consults the database for the dev (unprefixed) cookie name", async () => {
    currentHeaders = new Headers({ cookie: "better-auth.session_token=abc" });
    getSession.mockResolvedValueOnce({ userId: "usr_1" });

    expect(await isSignedIn()).toBe(true);
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("passes the request's OWN cookies to getSession (never a bare request)", async () => {
    currentHeaders = new Headers({ cookie: "__Secure-better-auth.session_token=abc" });
    getSession.mockResolvedValueOnce({ userId: "usr_1" });

    await isSignedIn();

    const passed = getSession.mock.calls[0][0] as Request;
    expect(passed.headers.get("cookie")).toBe("__Secure-better-auth.session_token=abc");
  });

  // The pool MUST be released even when the session read throws — a leaked Hyperdrive connection per login
  // page view is a real availability bug. The close rides ctx.waitUntil so it runs after the response.
  it("always releases the pool via waitUntil, even when getSession throws", async () => {
    currentHeaders = SIGNED_IN();
    getSession.mockRejectedValueOnce(new Error("db down"));

    await expect(isSignedIn()).rejects.toThrow("db down");

    expect(waitUntil).toHaveBeenCalledOnce();
    // The promise handed to waitUntil is the pool close.
    await waitUntil.mock.calls[0][0];
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the pool on the normal (signed-in) path too", async () => {
    currentHeaders = SIGNED_IN();
    getSession.mockResolvedValueOnce({ userId: "usr_1" });
    await isSignedIn();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  // There is no pool to release when we never opened one — and calling waitUntil here would be a lie.
  it("opens no pool to release on the short-circuit path", async () => {
    currentHeaders = new Headers();
    await isSignedIn();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

// The predicate decides whether we skip the DB entirely, so it has to be exactly right about what counts as
// the session cookie. Getting it WRONG IN EITHER DIRECTION is a real bug: a false negative signs a live user
// out of the resume path; a false positive just costs the DB read we were avoiding (safe, but pointless).
describe("hasSessionCookie", () => {
  it("recognises the prod (Secure-prefixed) and dev (bare) cookie names", () => {
    expect(hasSessionCookie("__Secure-better-auth.session_token=abc")).toBe(true);
    expect(hasSessionCookie("better-auth.session_token=abc")).toBe(true);
  });

  it("finds the session cookie among others, in any position", () => {
    expect(hasSessionCookie("wh_theme=dark; __Secure-better-auth.session_token=abc; x=1")).toBe(
      true,
    );
    expect(hasSessionCookie("a=1; better-auth.session_token=abc")).toBe(true);
  });

  it("is false with no cookie header, an empty one, or unrelated cookies", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("wh_theme=dark; consent=1")).toBe(false);
  });

  // A cookie whose name merely ENDS in the session cookie's name is a DIFFERENT cookie. Without the
  // name-boundary anchor a substring match would accept it, and an attacker who can set a cookie on the
  // registrable domain could force a signed-out user into the /session/handoff bounce.
  it("does not mistake a cookie merely ending in the session name for the session cookie", () => {
    expect(hasSessionCookie("evilbetter-auth.session_token=abc")).toBe(false);
    expect(hasSessionCookie("x=1; notbetter-auth.session_token=abc")).toBe(false);
  });

  // The VALUE is never inspected here — an empty/garbage value still goes to the DB, which is the authority.
  it("defers to the database when the cookie is present but empty", () => {
    expect(hasSessionCookie("better-auth.session_token=")).toBe(true);
  });
});
