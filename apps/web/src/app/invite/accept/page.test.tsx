import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionOrNull = vi.fn();
vi.mock("@/server/session", () => ({
  getSessionOrNull: () => getSessionOrNull(),
}));

const readInviteCookie = vi.fn(async (): Promise<{ org: string; token: string } | null> => null);
vi.mock("@/server/invite-cookie", () => ({
  readInviteCookie: () => readInviteCookie(),
}));

vi.mock("@/server/invite-actions", () => ({ acceptInviteAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import AcceptInvitePage from "./page";

const SESSION = {
  userId: "u",
  orgId: "o",
  user: { name: "Dana", email: "dana@acme.co", image: null },
};
const call = (sp: Record<string, string>) =>
  AcceptInvitePage({ searchParams: Promise.resolve(sp) });

beforeEach(() => {
  vi.clearAllMocks();
  readInviteCookie.mockResolvedValue(null);
});

describe("AcceptInvitePage", () => {
  // A Server Component render can't set a cookie, so the unauth branch hands off to the /invite/start route
  // handler (which stashes the cookie) — forwarding org + token same-origin.
  it("unauthenticated: hands off to /invite/start with the org and token forwarded", async () => {
    getSessionOrNull.mockResolvedValue(null);
    await expect(call({ org: "X", token: "SECRET" })).rejects.toThrow(
      "NEXT_REDIRECT:/invite/start?org=X&token=SECRET",
    );
  });

  it("unauthenticated with no token: hands off to /invite/start with just the org", async () => {
    getSessionOrNull.mockResolvedValue(null);
    await expect(call({ org: "X" })).rejects.toThrow("NEXT_REDIRECT:/invite/start?org=X");
  });

  it("signed in with a URL token: renders the Accept form (cookie not consulted)", async () => {
    getSessionOrNull.mockResolvedValue(SESSION);
    render(await call({ org: "X", token: "SECRET" }));
    expect(screen.getByRole("button", { name: /accept invite/i })).toBeInTheDocument();
    expect(readInviteCookie).not.toHaveBeenCalled();
  });

  it("signed in, no URL token, cookie holds a token for this org: renders the Accept form", async () => {
    getSessionOrNull.mockResolvedValue(SESSION);
    readInviteCookie.mockResolvedValue({ org: "X", token: "SECRET" });
    render(await call({ org: "X" }));
    expect(screen.getByRole("button", { name: /accept invite/i })).toBeInTheDocument();
  });

  it("signed in, no token anywhere: shows the incomplete-link message, no Accept form", async () => {
    getSessionOrNull.mockResolvedValue(SESSION);
    readInviteCookie.mockResolvedValue(null);
    render(await call({ org: "X" }));
    expect(screen.queryByRole("button", { name: /accept invite/i })).not.toBeInTheDocument();
    expect(screen.getByText(/incomplete or has been altered/i)).toBeInTheDocument();
  });

  it("signed in, cookie token is for a DIFFERENT org: treated as incomplete (ignored)", async () => {
    getSessionOrNull.mockResolvedValue(SESSION);
    readInviteCookie.mockResolvedValue({ org: "OTHER", token: "SECRET" });
    render(await call({ org: "X" }));
    expect(screen.queryByRole("button", { name: /accept invite/i })).not.toBeInTheDocument();
  });
});
