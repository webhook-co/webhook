import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the hero headline as the single h1", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /the webhook platform built for the agent era/i,
      }),
    ).toBeInTheDocument();
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<HomePage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders the primary call to action", () => {
    render(<HomePage />);
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
  });
});
