import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("defaults to the neutral monochrome tone", () => {
    render(<Badge>draft</Badge>);
    expect(screen.getByText("draft")).toHaveClass("text-fg-secondary");
  });

  it("applies a functional tone when asked", () => {
    render(<Badge tone="danger">failed</Badge>);
    const el = screen.getByText("failed");
    expect(el).toHaveClass("text-danger");
    expect(el).toHaveClass("bg-danger-bg");
  });
});
