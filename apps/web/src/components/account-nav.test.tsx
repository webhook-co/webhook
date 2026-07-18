import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/account/profile" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { AccountNav } from "./account-nav";

afterEach(() => {
  nav.pathname = "/account/profile";
});

describe("AccountNav", () => {
  it("points Profile at its own /account/profile route", () => {
    render(<AccountNav />);
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/account/profile",
    );
  });

  it("marks Profile active on /account/profile (exact match, not on connected-apps)", () => {
    nav.pathname = "/account/connected-apps";
    const { rerender } = render(<AccountNav />);
    // On connected-apps, Profile must NOT be current.
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );

    nav.pathname = "/account/profile";
    rerender(<AccountNav />);
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
  });

  // The account links live in a real labeled group (#20), not a decorative sibling heading. Locks the
  // aria-labelledby name so the grouping can't silently flatten back.
  it("groups the account links in a list labeled 'Account'", () => {
    render(<AccountNav />);
    const group = screen.getByRole("list", { name: "Account" });
    expect(within(group).getByRole("link", { name: "Profile" })).toBeInTheDocument();
  });
});
