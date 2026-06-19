import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./icon-button";

// A stand-in icon (the real consumers pass a lucide-react icon).
function Dot() {
  return <svg data-testid="icon" viewBox="0 0 24 24" />;
}

describe("IconButton", () => {
  it("exposes its accessible name via the required aria-label", () => {
    render(
      <IconButton aria-label="Toggle theme">
        <Dot />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
  });

  it("renders the icon child", () => {
    render(
      <IconButton aria-label="More">
        <Dot />
      </IconButton>,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("is square (no horizontal padding) at the chosen size", () => {
    render(
      <IconButton aria-label="More" size="sm">
        <Dot />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "More" });
    expect(btn.className).toContain("size-[34px]");
    expect(btn.className).toContain("p-0");
  });

  it("carries the variant styling", () => {
    render(
      <IconButton aria-label="Delete" variant="danger">
        <Dot />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("bg-danger");
  });

  it("fires onClick when pressed", async () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Go" onClick={onClick}>
        <Dot />
      </IconButton>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Go" onClick={onClick} disabled>
        <Dot />
      </IconButton>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("forwards a ref to the button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <IconButton aria-label="X" ref={ref}>
        <Dot />
      </IconButton>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
