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

import { isSignedIn } from "./resolve-signed-in";

beforeEach(() => {
  vi.clearAllMocks();
  currentHeaders = new Headers();
});

describe("isSignedIn", () => {
  it("is true when the IdP has a live session", async () => {
    getSession.mockResolvedValueOnce({ userId: "usr_1" });
    expect(await isSignedIn()).toBe(true);
  });

  it("is false when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    expect(await isSignedIn()).toBe(false);
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
    getSession.mockRejectedValueOnce(new Error("db down"));

    await expect(isSignedIn()).rejects.toThrow("db down");

    expect(waitUntil).toHaveBeenCalledOnce();
    // The promise handed to waitUntil is the pool close.
    await waitUntil.mock.calls[0][0];
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the pool on the normal (signed-in) path too", async () => {
    getSession.mockResolvedValueOnce({ userId: "usr_1" });
    await isSignedIn();
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
