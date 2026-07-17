import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EventsFilterBar } from "./events-filter-bar";

// The bar is URL-driven (next/navigation); stub the hooks so it renders deterministically with no query.
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
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

describe("EventsFilterBar — the endpoint facet (org-wide browse only)", () => {
  const EP_A = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
  const EP_B = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5099";
  const endpoints = [
    { id: EP_A, name: "stripe-prod", deleted: false },
    { id: EP_B, name: "old-hook", deleted: true },
  ];

  // The per-endpoint page must render EXACTLY as it does today: a column/control repeating the one endpoint
  // it is already scoped to would be noise.
  it("renders NO endpoint facet when `endpoints` is omitted", () => {
    render(<EventsFilterBar providers={["stripe"]} />);
    expect(screen.queryByRole("button", { name: /Filter by endpoint/ })).not.toBeInTheDocument();
  });

  it("renders the endpoint facet when `endpoints` is passed", () => {
    render(<EventsFilterBar providers={["stripe"]} endpoints={endpoints} />);
    expect(screen.getByRole("button", { name: /Filter by endpoint/ })).toBeInTheDocument();
  });

  // The house idiom: the raw id is NEVER the visible label.
  it("lists endpoints by NAME, never by raw uuid", async () => {
    render(<EventsFilterBar providers={["stripe"]} endpoints={endpoints} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by endpoint/ }));
    expect(screen.getByRole("option", { name: /stripe-prod/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: EP_A })).not.toBeInTheDocument();
  });

  // A soft-deleted endpoint still has events (ADR-0076), so it must be selectable — but the control must not
  // present it as if it were live.
  it("marks a soft-deleted endpoint rather than hiding or mislabelling it", async () => {
    render(<EventsFilterBar providers={["stripe"]} endpoints={endpoints} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by endpoint/ }));
    expect(screen.getByRole("option", { name: /old-hook \(deleted\)/ })).toBeInTheDocument();
  });

  it('offers an "All endpoints" option to clear the drill-down', async () => {
    render(<EventsFilterBar providers={["stripe"]} endpoints={endpoints} />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by endpoint/ }));
    expect(screen.getByRole("option", { name: "All endpoints" })).toBeInTheDocument();
  });
});

// The 3-char floor, as the READER experiences it. pg_trgm extracts zero trigrams below 3 characters, so a
// short term genuinely cannot run — but it used to be dropped in SILENCE, handing back the full unfiltered
// list and leaving the reader to infer their search never happened.
describe("EventsFilterBar — the search floor is explained, not silently enforced", () => {
  it("says why a 1-2 char term has not run, and stops once it can", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText("Search events");

    expect(screen.queryByText(/Keep typing/)).not.toBeInTheDocument();

    await user.type(input, "ab");
    expect(screen.getByText(/Keep typing/)).toBeVisible();
    // Announced, and tied to the input — a sighted reader sees it, a screen-reader user is told.
    expect(screen.getByRole("status")).toHaveTextContent(/at least 3 characters/);
    expect(input).toHaveAccessibleDescription(/Keep typing/);

    await user.type(input, "c");
    expect(screen.queryByText(/Keep typing/)).not.toBeInTheDocument();
  });

  it("does not nag someone who typed only whitespace", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.type(screen.getByLabelText("Search events"), "  ");
    expect(screen.queryByText(/Keep typing/)).not.toBeInTheDocument();
  });
});
