import { PROVIDER_BRANDING } from "@webhook-co/ui";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvidersWall } from "./providers-wall";

const COUNT = Object.keys(PROVIDER_BRANDING).length;

describe("ProvidersWall", () => {
  it("headlines the provider count (derived from the branding map)", () => {
    render(<ProvidersWall />);
    const heading = screen.getByRole("heading", {
      level: 2,
      name: /verification built in for \d+ providers/i,
    });
    expect(heading).toHaveTextContent(`for ${COUNT} providers`);
  });

  it("renders one pill per branded provider, naming recognizable ones", () => {
    render(<ProvidersWall />);
    expect(screen.getAllByRole("listitem")).toHaveLength(COUNT);
    expect(screen.getByText("Stripe")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Mercado Pago")).toBeInTheDocument();
  });
});
