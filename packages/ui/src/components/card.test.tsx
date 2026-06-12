import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

describe("Card", () => {
  it("renders the full composition", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>Delivery target</CardDescription>
        </CardHeader>
        <CardContent>body</CardContent>
        <CardFooter>footer</CardFooter>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Endpoint" })).toBeInTheDocument();
    expect(screen.getByText("Delivery target")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByText("footer")).toBeInTheDocument();
  });

  it("carries the surface + hairline styling", () => {
    const { container } = render(<Card>x</Card>);
    expect(container.firstChild).toHaveClass("border-hairline");
    expect(container.firstChild).toHaveClass("bg-surface");
  });
});
