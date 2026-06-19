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

  it("reflects the visual side via data-side", () => {
    const { container } = render(
      <AuthShell side="left" visual={<p>v</p>}>
        x
      </AuthShell>,
    );
    expect(container.querySelector('[data-side="left"]')).not.toBeNull();
  });
});
