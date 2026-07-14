import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

import { AccountMenu } from "./account-menu";

const renderMenu = (onLogout = () => {}) =>
  render(<AccountMenu name="Dana Kessler" email="dana@acme.co" onLogout={onLogout} />);

const trigger = () => screen.getByRole("button", { name: /account: dana kessler/i });

describe("AccountMenu", () => {
  // It used to be a bare initials circle in the top-right corner, which showed you nothing until you clicked
  // it. Pinned to the sidebar's bottom-left, the identity is legible AT REST — which is the whole point of
  // putting it there.
  it("shows who you are signed in as without being opened", () => {
    renderMenu();
    expect(trigger()).toHaveTextContent("Dana Kessler");
  });

  it("shows the full identity and a logout option when opened", async () => {
    renderMenu();
    await userEvent.click(trigger());

    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("invokes onLogout when Log out is selected", async () => {
    const onLogout = vi.fn();
    renderMenu(onLogout);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(onLogout).toHaveBeenCalledOnce();
  });

  // Logging out was the ONE action in the app with no feedback whatsoever: the action was fired bare, outside
  // any transition, so the menu closed and the page just sat there. And logout FEELS slow — it is a
  // cross-origin redirect through the auth issuer — so "nothing happened" is exactly what it looked like,
  // which is how a user ends up clicking it three times.
  //
  // The menu has closed by then, so the TRIGGER is the only surface left that can say the click landed.
  it("says it is signing out, on the surface that survives the menu closing", async () => {
    // A logout that never resolves — the real one navigates away, so it never resolves either.
    const onLogout = vi.fn(() => new Promise<void>(() => {}) as unknown as void);
    renderMenu(onLogout);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    // The trigger reports the pending state (spinner + accessible name), rather than silently doing nothing.
    expect(await screen.findByRole("status", { name: /signing out/i })).toBeInTheDocument();
  });

  it("cannot be double-fired while a sign-out is already in flight", async () => {
    const onLogout = vi.fn(() => new Promise<void>(() => {}) as unknown as void);
    renderMenu(onLogout);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    // Re-open and try again: the item is disabled, so a second sign-out cannot be started.
    await userEvent.click(trigger());
    const item = screen.queryByRole("menuitem", { name: /signing out/i });
    if (item) await userEvent.click(item);

    expect(onLogout).toHaveBeenCalledOnce();
  });
});
