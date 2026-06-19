import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = { get: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  // The real redirect() throws to halt rendering; mirror that so a gated call can't fall through.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { redirect } from "next/navigation";

import { SESSION_COOKIE, verifySession } from "./session";

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

  it("redirects to login when the session cookie is empty", async () => {
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: "" });
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:/);
  });

  it("returns the session principal when the cookie is present", async () => {
    cookieStore.get.mockReturnValue({ name: SESSION_COOKIE, value: "mock-token" });
    const session = await verifySession();
    expect(session.orgId).toBeTruthy();
    expect(session.userId).toBeTruthy();
    expect(session.user.email).toContain("@");
    expect(redirect).not.toHaveBeenCalled();
  });
});
