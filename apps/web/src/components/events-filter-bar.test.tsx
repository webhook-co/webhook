import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventsFilterBar, SEARCH_DEBOUNCE_MS } from "./events-filter-bar";

// A STABLE spy: the router hook must return the same fn across renders, or a fresh vi.fn() per call makes
// what the bar pushed unobservable — and what it pushes to the URL is the contract under test.
const replace = vi.fn();

// Mutable so a test can seed the bar with an existing query (e.g. an already-applied event-type filter).
// Reset to empty before each test.
let mockSearch = "";

// The bar is URL-driven (next/navigation); stub the hooks so it renders deterministically with no query.
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ push: vi.fn(), replace: (...args: unknown[]) => replace(...args) }),
  usePathname: () => "/endpoints/ep/events",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

beforeEach(() => {
  replace.mockClear();
  mockSearch = "";
});

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

// A TERM THAT CANNOT RUN MUST NOT REACH THE URL.
//
// The debounce pushed ANY non-empty term, so typing "ab" wrote `?search=ab`, lit up Clear, and cost a server
// round trip — for a term parseEventFilters then DROPS (pg_trgm extracts no trigrams below 3 chars, so no
// index can serve it). The URL claimed a filter, the Clear affordance claimed a filter, and the list showed
// every event in the org. Two comments in this file asserted the term was never passed on; they described the
// SQL, not the URL, and the URL is what the reader sees and shares.
describe("EventsFilterBar — the URL never carries a search that cannot run", () => {
  it("does not push a 1-2 char term", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.type(screen.getByLabelText("Search events"), "ab");
    // Past the debounce window with room to spare: if it were going to push, it has had its chance.
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 150));
    expect(replace).not.toHaveBeenCalled();
  });

  it("pushes as soon as the term can run", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.type(screen.getByLabelText("Search events"), "abc");
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(expect.stringContaining("search=abc"), {
        scroll: false,
      }),
    );
  });
});

// THE NEW FACETS render with human labels (never raw slugs), and event type commits on Enter/blur.
describe("EventsFilterBar — method / dedup strategy / event type facets", () => {
  it("the dedup-strategy facet shows human labels, never the raw enum slug", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.click(screen.getByRole("button", { name: /Filter by dedup strategy/ }));
    expect(screen.getByRole("option", { name: "Content hash" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unique (no dedup)" })).toBeInTheDocument();
    // the raw slug is never an option label
    expect(screen.queryByRole("option", { name: "content_hash" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "sw_webhook_id" })).not.toBeInTheDocument();
  });

  it("the method facet offers the seven verbs", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.click(screen.getByRole("button", { name: /Filter by HTTP method/ }));
    for (const verb of ["GET", "POST", "DELETE", "OPTIONS"]) {
      expect(screen.getByRole("option", { name: verb })).toBeInTheDocument();
    }
  });

  it("event type is a free text input; the coverage caveat stays silent until a filter is set", () => {
    // No event-type filter yet: the caveat text is empty and the input does NOT point at it, so a screen
    // reader doesn't announce the whole provider-coverage sentence on every focus of an empty box.
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText("Filter by event type");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/parsed for some providers only/)).not.toBeInTheDocument();
  });

  it("the coverage caveat is announced once an event-type filter is applied", () => {
    mockSearch = "eventType=charge.succeeded";
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText("Filter by event type");
    expect(input).toHaveAttribute("aria-describedby", "events-eventtype-hint");
    expect(screen.getByText(/parsed for some providers only/)).toBeInTheDocument();
  });

  it("commits a trimmed event type on blur, normalizing the visible value", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
    await user.type(input, "  charge.succeeded  ");
    await user.tab(); // blur → commit
    // The applied value reaches the URL trimmed…
    expect(replace).toHaveBeenCalled();
    const url = String(replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain("eventType=charge.succeeded");
    expect(url).not.toContain("+charge"); // no leading whitespace survived
    // …and the box itself no longer shows the stray whitespace.
    expect(input.value).toBe("charge.succeeded");
  });

  it("never pushes an over-long event type (the parser would drop it → silent-drop cliff)", () => {
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
    // maxLength caps typing, but a paste could still exceed it. fireEvent.change bypasses the DOM cap (as a
    // paste effectively does) to land an over-long value in React state, then blur commits.
    const tooLong = "x".repeat(1000);
    fireEvent.change(input, { target: { value: tooLong } });
    fireEvent.blur(input);
    // No URL push carries the un-appliable term (it collapses to "no filter", exactly what the parser does).
    for (const call of replace.mock.calls) {
      expect(String(call[0])).not.toContain(tooLong);
    }
    // And the box is normalized back to empty rather than lingering with an un-appliable value.
    expect(input.value).toBe("");
  });

  it("Clear filters wipes typed-but-uncommitted event-type text", async () => {
    // With a filter already applied, Clear is enabled. An event type typed but not yet committed (no
    // Enter/blur) has no URL value to sync from, so it would linger after Clear unless reset explicitly.
    mockSearch = "provider=stripe";
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
    await user.type(input, "charge.succeeded");
    expect(input.value).toBe("charge.succeeded");
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(input.value).toBe("");
  });
});
