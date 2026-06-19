import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("exposes a status role with a default accessible name", () => {
    render(<Spinner />);
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading");
  });

  it("accepts a custom label", () => {
    render(<Spinner label="Revoking key" />);
    expect(screen.getByRole("status")).toHaveAccessibleName("Revoking key");
  });

  it("applies the size class for the chosen size", () => {
    render(<Spinner size="lg" data-testid="sp" />);
    expect(screen.getByTestId("sp").className).toContain("size-6");
  });

  it("defaults to the md size", () => {
    render(<Spinner data-testid="sp" />);
    expect(screen.getByTestId("sp").className).toContain("size-5");
  });

  it("disables the spin animation under reduced-motion", () => {
    render(<Spinner data-testid="sp" />);
    expect(screen.getByTestId("sp").querySelector("svg")?.getAttribute("class")).toContain(
      "motion-reduce:animate-none",
    );
  });

  it("forwards a custom className", () => {
    render(<Spinner data-testid="sp" className="text-fg-faint" />);
    expect(screen.getByTestId("sp").className).toContain("text-fg-faint");
  });
});
