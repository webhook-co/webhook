import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = { get: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  // The real redirect() throws to halt rendering; mirror that so a gated call can't fall through.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const TEST_SECRET = "verify-session-test-secret-aaaaaaaaaaaaaaaa";
vi.mock("./env", () => ({
  getSessionSecret: vi.fn(async () => TEST_SECRET),
  getAuthBaseUrl: vi.fn(() => "http://auth.test"),
}));

import { redirect } from "next/navigation";

import {
  getSessionOrNull,
  loginUrlWithReturn,
  SESSION_COOKIE,
  type Session,
  verifySession,
} from "./session";
import { signSessionToken } from "./session-token";

const principal: Session = {
  userId: "usr_dana",
  orgId: "org_acme",
  user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
};

describe("verifySession", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    vi.mocked(redirect).mockClear();
  });

  it("redirects to login when the session cookie is absent", async () => {
    cookieStore.get.mockReturnValue(undefined);
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(redirect).toHaveBeenCalledOnce();
    expect(cookieStore.get).toHaveBeenCalledWith(SESSION_COOKIE);
  });

  it("sends the unauthenticated request to the login surface on the AUTH origin (never a relative /login on app.)", async () => {
    cookieStore.get.mockReturnValue(undefined);
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
    // getAuthBaseUrl() is mocked to the auth origin; the gate must target it, not app.'s own /login (404).
    expect(redirect).toHaveBeenCalledWith("http://auth.test/login");
  });

  it("redirects to login when the session cookie is empty", async () => {
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: "" });
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
  });

  it("redirects when the cookie value is not a valid signed token", async () => {
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: "not-a-real-token" });
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
  });

  it("redirects when the token is forged (signed with another secret)", async () => {
    const forged = await signSessionToken(principal, "not-the-server-secret", 3600);
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: forged });
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
  });

  it("redirects when the token is expired", async () => {
    const expired = await signSessionToken(principal, TEST_SECRET, -10);
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: expired });
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
  });

  it("returns the decoded principal for a valid token", async () => {
    const token = await signSessionToken(principal, TEST_SECRET, 3600);
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: token });
    const session = await verifySession();
    expect(session).toMatchObject(principal);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("getSessionOrNull", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    vi.mocked(redirect).mockClear();
  });

  it("returns null (never redirects) when there is no valid session", async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect(await getSessionOrNull()).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns the decoded principal for a valid token", async () => {
    const token = await signSessionToken(principal, TEST_SECRET, 3600);
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: token });
    expect(await getSessionOrNull()).toMatchObject(principal);
  });
});

describe("loginUrlWithReturn", () => {
  // Better Auth's callbackURL guard for a relative value. The `redirect` param (= the callbackURL after auth's
  // resolvePostLoginTarget) MUST match, or sign-in 403s INVALID_CALLBACK_URL. This pins the once-encoding
  // footgun deterministically without a live Better Auth server.
  const BA_CALLBACK_RE = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

  it("nests the app path as a once-encoded next inside the handoff target", () => {
    const u = new URL(loginUrlWithReturn("/invite/accept?org=X"));
    // URLSearchParams.get decodes once → the value auth's resolvePostLoginTarget receives.
    const redirectParam = u.searchParams.get("redirect")!;
    expect(redirectParam).toBe("/session/handoff?next=%2Finvite%2Faccept%3Forg%3DX");
  });

  it("produces a redirect value that PASSES Better Auth's callbackURL guard (no 403)", () => {
    const redirectParam = new URL(loginUrlWithReturn("/invite/accept?org=X")).searchParams.get(
      "redirect",
    )!;
    expect(BA_CALLBACK_RE.test(redirectParam)).toBe(true);
  });

  it("targets the auth-origin login surface", () => {
    expect(loginUrlWithReturn("/invite/accept?org=X").startsWith("http://auth.test/login?")).toBe(
      true,
    );
  });
});
