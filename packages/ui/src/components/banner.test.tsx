import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Banner } from "./banner";

describe("Banner", () => {
  it("renders its message", () => {
    render(<Banner>Your key was revoked.</Banner>);
    expect(screen.getByText("Your key was revoked.")).toBeInTheDocument();
  });

  it("renders an optional title", () => {
    render(<Banner title="Heads up">Check your config.</Banner>);
    expect(screen.getByText("Heads up")).toBeInTheDocument();
  });

  it("uses role=alert for the danger tone", () => {
    render(<Banner tone="danger">Something failed.</Banner>);
    expect(screen.getByRole("alert")).toHaveTextContent("Something failed.");
  });

  it("uses role=status for non-danger tones", () => {
    render(<Banner tone="ok">Saved.</Banner>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  });

  it("renders a dismiss control and calls onDismiss when provided", async () => {
    const onDismiss = vi.fn();
    render(<Banner onDismiss={onDismiss}>Dismissable.</Banner>);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("has no dismiss control without onDismiss", () => {
    render(<Banner>Not dismissable.</Banner>);
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("applies the tone styling", () => {
    render(<Banner tone="danger">Failure.</Banner>);
    expect(screen.getByRole("alert")).toHaveClass("bg-danger-bg");
  });

  it("renders the warn tone", () => {
    render(<Banner tone="warn">Approaching your soft cap.</Banner>);
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("bg-warn-bg");
    expect(banner).toHaveTextContent("Approaching your soft cap.");
  });
});
