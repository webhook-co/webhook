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
