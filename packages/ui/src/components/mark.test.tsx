import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Mark, Wordmark } from "./mark";

describe("Mark", () => {
  it("renders an accessible svg at the requested size", () => {
    render(<Mark size={48} />);
    const svg = screen.getByRole("img", { name: "webhook.co" });
    expect(svg).toHaveAttribute("width", "48");
    expect(svg).toHaveAttribute("stroke-width", "3");
  });
});

describe("Wordmark", () => {
  it("renders the lowercase lockup with a de-emphasized .co", () => {
    render(<Wordmark />);
    expect(screen.getByText(/webhook/)).toBeInTheDocument();
    expect(screen.getByText(".co")).toBeInTheDocument();
  });

  it("can render without the mark", () => {
    render(<Wordmark hideMark />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
