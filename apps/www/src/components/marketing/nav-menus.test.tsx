import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { axeComponent } from "@/test/axe";

import { NavMenus } from "./nav-menus";

function renderWithOutside() {
  return render(
    <div>
      <NavMenus />
      <button type="button">outside</button>
    </div>,
  );
}

const trigger = (name: RegExp) => screen.getByRole("button", { name });

describe("NavMenus", () => {
  it("starts closed with the links present but hidden (no-JS reachable)", () => {
    render(<NavMenus />);
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById("navmenu-product");
    expect(panel).toHaveAttribute("hidden");
    expect(
      within(panel as HTMLElement).getByRole("link", { name: "Capture & replay", hidden: true }),
    ).toHaveAttribute("href", "#");
  });

  it("opens on click and reveals the links", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById("navmenu-product") as HTMLElement;
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).getByRole("link", { name: "Delivery" })).toBeInTheDocument();
  });

  it("uses the real Standard Webhooks URL under Developers", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^developers$/i));
    const panel = document.getElementById("navmenu-developers") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "Standard Webhooks" })).toHaveAttribute(
      "href",
      "https://www.standardwebhooks.com/",
    );
  });

  it("keeps only one menu open at a time", async () => {
    render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    await userEvent.click(trigger(/^developers$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
    expect(trigger(/^developers$/i)).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render(<NavMenus />);
    const product = trigger(/^product$/i);
    await userEvent.click(product);
    await userEvent.keyboard("{Escape}");
    expect(product).toHaveAttribute("aria-expanded", "false");
    expect(product).toHaveFocus();
  });

  it("closes on an outside pointer press", async () => {
    renderWithOutside();
    await userEvent.click(trigger(/^product$/i));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(trigger(/^product$/i)).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when focus leaves the menu", async () => {
    renderWithOutside();
    const product = trigger(/^product$/i);
    await userEvent.click(product);
    fireEvent.focusOut(product, {
      relatedTarget: screen.getByRole("button", { name: "outside" }),
    });
    expect(product).toHaveAttribute("aria-expanded", "false");
  });

  it("has no axe violations (closed and open)", async () => {
    const { container } = render(<NavMenus />);
    expect(await axeComponent(container)).toHaveNoViolations();
    await userEvent.click(trigger(/^product$/i));
    expect(await axeComponent(container)).toHaveNoViolations();
  });

  it("removes its document listeners on unmount", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<NavMenus />);
    await userEvent.click(trigger(/^product$/i));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    removeSpy.mockRestore();
  });
});
