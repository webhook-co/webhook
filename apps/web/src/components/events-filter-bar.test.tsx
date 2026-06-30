import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EventsFilterBar } from "./events-filter-bar";

// The bar is URL-driven (next/navigation); stub the hooks so it renders deterministically with no query.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/endpoints/ep/events",
  useSearchParams: () => new URLSearchParams(""),
}));

describe("EventsFilterBar", () => {
  it("renders provider options as display names with brand logos (not raw slugs)", async () => {
    render(<EventsFilterBar providers={["stripe", "github"]} />);

    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));

    const stripe = screen.getByRole("option", { name: "Stripe" });
    const github = screen.getByRole("option", { name: "GitHub" });
    expect(stripe).toBeInTheDocument();
    expect(github).toBeInTheDocument();
    // The raw lowercase slug is never the visible option label.
    expect(screen.queryByRole("option", { name: "stripe" })).not.toBeInTheDocument();
    // Each option carries its brand mark (an inline SVG from ProviderLogo).
    expect(stripe.querySelector("svg")).toBeTruthy();
    expect(github.querySelector("svg")).toBeTruthy();
  });
});
