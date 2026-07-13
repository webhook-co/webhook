import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "./button";

describe("Button", () => {
  it("renders a button with the label", () => {
    render(<Button>Start free</Button>);
    expect(screen.getByRole("button", { name: "Start free" })).toBeInTheDocument();
  });

  it("defaults to type=button so it never accidentally submits a form", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("applies the requested variant and size classes", () => {
    render(
      <Button variant="danger" size="lg">
        Delete endpoint
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveClass("bg-danger");
    expect(btn).toHaveClass("h-12");
  });

  it("forwards click handlers", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders as a child element when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/docs">Read the docs</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Read the docs" });
    expect(link).toHaveAttribute("href", "/docs");
    expect(link).not.toHaveAttribute("type");
  });

  it("merges a caller className over defaults", () => {
    render(<Button className="w-full">Wide</Button>);
    expect(screen.getByRole("button")).toHaveClass("w-full");
  });

  it("exposes a variants helper", () => {
    expect(buttonVariants({ variant: "ghost" })).toContain("bg-transparent");
  });
});

// `loading` exists because "pending" was previously expressed as a bare `disabled` — which tells a user a
// control is UNAVAILABLE, not that their click was heard. That is the difference between an app that looks
// broken and one that looks like it is working, and the dashboard was shipping the first one.
describe("Button loading", () => {
  it("shows a spinner and marks itself busy", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: /save/i });

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("svg")).toBeInTheDocument();
  });

  // THE reason this prop exists in the first place. A loading button that can still be clicked is a
  // double-submitted invite / key mint / delete — a real bug, not a cosmetic one.
  it("cannot be clicked while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Invite
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: /invite/i }));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /invite/i })).toBeDisabled();
  });

  // The subtle one: `disabled ?? loading` would leave THIS button clickable while loading, because an
  // explicit `false` is not nullish. It must be `||`. Without this test that bug is invisible — the button
  // still spins, it just also still fires.
  it("stays un-clickable while loading even when explicitly disabled={false}", async () => {
    const onClick = vi.fn();
    render(
      <Button loading disabled={false} onClick={onClick}>
        Delete
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(onClick).not.toHaveBeenCalled();
  });

  // The label must not be replaced by the spinner: swapping it resizes the button mid-click and the row
  // reflows. Keeping it holds the width stable — and keeps the accessible name intact.
  it("keeps its label (and therefore its width) while loading", () => {
    const { rerender } = render(<Button>Send invite</Button>);
    expect(screen.getByRole("button", { name: "Send invite" })).toBeInTheDocument();

    rerender(<Button loading>Send invite</Button>);
    expect(screen.getByRole("button", { name: "Send invite" })).toBeInTheDocument();
  });

  // The spinner REPLACES the icon rather than joining it. If the icon lived in `children` we would render two
  // glyphs and grow the button mid-click, and every call site would have to remember to hide its own icon.
  it("swaps the icon for the spinner rather than showing both", () => {
    const icon = <svg data-testid="glyph" />;

    const { rerender } = render(<Button icon={icon}>Continue with Google</Button>);
    expect(screen.getByTestId("glyph")).toBeInTheDocument();

    rerender(
      <Button icon={icon} loading>
        Continue with Google
      </Button>,
    );
    expect(screen.queryByTestId("glyph")).not.toBeInTheDocument();
    expect(screen.getByRole("button").querySelector("svg")).toBeInTheDocument();
  });

  it("is a normal, clickable button when not loading", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /save/i })).not.toHaveAttribute("aria-busy");
  });

  // The spinner must NOT announce itself: `aria-busy` on the button already carries the meaning, and a second
  // live region would talk over the label. So the accessible name stays exactly the label — no "Loading".
  it("does not let the spinner pollute the accessible name", () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // asChild hands rendering to the caller's element (an anchor). Slot takes exactly ONE child, so injecting a
  // spinner would throw — and a link navigates, so it has no pending state to show.
  it("does not inject a spinner under asChild (Slot takes one child)", () => {
    expect(() =>
      render(
        <Button asChild loading>
          <a href="/somewhere">Go</a>
        </Button>,
      ),
    ).not.toThrow();

    const link = screen.getByRole("link", { name: "Go" });
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link.querySelector("svg")).not.toBeInTheDocument();
  });
});
