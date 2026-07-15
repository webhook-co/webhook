import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => nav);

import AccountPage from "./page";

describe("AccountPage (/account index)", () => {
  it("redirects to /account/profile (Profile now lives at its own route)", () => {
    expect(() => AccountPage()).toThrow("REDIRECT:/account/profile");
    expect(nav.redirect).toHaveBeenCalledWith("/account/profile");
  });
});
