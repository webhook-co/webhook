import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuthShell } from "./auth-shell";

describe("AuthShell", () => {
  it("renders the form content", () => {
    render(
      <AuthShell>
        <form aria-label="sign in">body</form>
      </AuthShell>,
    );
    expect(screen.getByRole("form", { name: "sign in" })).toBeInTheDocument();
  });

  it("renders the webhook.co lockup", () => {
    render(<AuthShell>x</AuthShell>);
    expect(screen.getByText(/webhook/)).toBeInTheDocument();
  });

  it("exposes the form pane as the main landmark", () => {
    render(
      <AuthShell visual={<p>decorative</p>}>
        <form aria-label="sign in">body</form>
      </AuthShell>,
    );
    // the form content is the page's primary landmark; the visual pane is not
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("form", { name: "sign in" }),
    );
  });

  it("renders the actions slot (e.g. a theme toggle)", () => {
    render(<AuthShell actions={<button>toggle theme</button>}>x</AuthShell>);
    expect(screen.getByRole("button", { name: "toggle theme" })).toBeInTheDocument();
  });

  it("renders the footer slot", () => {
    render(<AuthShell footer={<p>legal terms</p>}>x</AuthShell>);
    expect(screen.getByText("legal terms")).toBeInTheDocument();
  });

  it("renders the visual pane content as a decorative (aria-hidden) region", () => {
    render(<AuthShell visual={<p>brand quote</p>}>x</AuthShell>);
    expect(screen.getByText("brand quote").closest("aside")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders no visual pane when none is given", () => {
    const { container } = render(<AuthShell>x</AuthShell>);
    expect(container.querySelector("aside")).toBeNull();
  });

  it("links the lockup home when homeHref is set", () => {
    render(<AuthShell homeHref="/">x</AuthShell>);
    expect(screen.getByRole("link", { name: "webhook.co home" })).toHaveAttribute("href", "/");
  });

  it("moves the lockup out of the top bar (above the form) when centerLockup is set", () => {
    render(
      <AuthShell centerLockup homeHref="/" actions={<button>toggle theme</button>}>
        <form aria-label="sign in">body</form>
      </AuthShell>,
    );
    const lockup = screen.getByRole("link", { name: "webhook.co home" });
    const toggle = screen.getByRole("button", { name: "toggle theme" });
    // Still present, still in the main pane…
    expect(lockup).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(lockup);
    // …but NOT sharing the top bar with the actions — it has moved above the form card.
    expect(lockup.parentElement).not.toBe(toggle.parentElement);
  });

  it("keeps the lockup in the top bar (with the actions) by default", () => {
    render(
      <AuthShell homeHref="/" actions={<button>toggle theme</button>}>
        x
      </AuthShell>,
    );
    const lockup = screen.getByRole("link", { name: "webhook.co home" });
    const toggle = screen.getByRole("button", { name: "toggle theme" });
    expect(lockup.parentElement).toBe(toggle.parentElement);
  });

  it("reflects the visual side via data-side", () => {
    const { container } = render(
      <AuthShell side="left" visual={<p>v</p>}>
        x
      </AuthShell>,
    );
    expect(container.querySelector('[data-side="left"]')).not.toBeNull();
  });

  // NOTE: jsdom can't evaluate the cascade, so these assert the WIRING (the classes/structure that drive
  // the layout), not the rendered pixels — the actual centering still needs a human eyeball.
  it("logoAlign='center' wires the top bar to justify-center with actions pinned right", () => {
    const { container } = render(
      <AuthShell logoAlign="center" actions={<button>toggle</button>}>
        x
      </AuthShell>,
    );
    const topBar = container.querySelector("main > div");
    expect(topBar?.className).toContain("justify-center");
    const pinned = topBar?.querySelector(".absolute.right-0");
    expect(pinned).not.toBeNull();
    expect(pinned?.textContent).toContain("toggle");
  });

  it("default (logoAlign='left') keeps justify-between with inline actions (login/device unchanged)", () => {
    const { container } = render(<AuthShell actions={<button>toggle</button>}>x</AuthShell>);
    const topBar = container.querySelector("main > div");
    expect(topBar?.className).toContain("justify-between");
    expect(topBar?.querySelector(".absolute.right-0")).toBeNull();
  });
});
