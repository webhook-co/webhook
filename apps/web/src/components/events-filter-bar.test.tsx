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

  // The endpoint (and date) controls push via applyPatch, which — unlike the multi-selects — carried no
  // optimistic state of its own, so a pick used to lag the RSC round trip while the facet chips jumped ahead.
  // The single-snapshot model updates every control on the same render; this pins that for the endpoint.
  it("shows a just-picked endpoint immediately, before the navigation commits", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} endpoints={endpoints} />);
    const trigger = screen.getByRole("button", { name: /Filter by endpoint/ });
    expect(trigger).toHaveTextContent("All endpoints"); // nothing selected yet
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "stripe-prod" }));
    // The committed URL (mockSearch) never changed — this asserts the OPTIMISTIC snapshot renders the pick at
    // once, not a render or two later when the navigation lands.
    expect(screen.getByRole("button", { name: /Filter by endpoint/ })).toHaveTextContent(
      "stripe-prod",
    );
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
    // Announced, and tied to the input — a sighted reader sees it, a screen-reader user is told. There are two
    // always-mounted status regions (search + event-type coverage); assert one of them carries the message.
    const liveRegions = screen.getAllByRole("status");
    expect(liveRegions.some((r) => /at least 3 characters/.test(r.textContent ?? ""))).toBe(true);
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

  it("header search is a free text input; the slower-scan hint stays silent until a filter is set", () => {
    // #24: no header-search filter yet → the perf caveat is silent and the box doesn't point at it (so a
    // screen reader doesn't announce "slower scan" on every focus of an empty box). Mirrors eventType.
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText("Search request headers");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/scans the raw request headers/)).not.toBeInTheDocument();
  });

  it("the slower-scan hint is announced once a header search is applied", () => {
    mockSearch = "headerSearch=x-shopify-topic";
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText("Search request headers");
    expect(input).toHaveAttribute("aria-describedby", "events-headersearch-hint");
    expect(screen.getByText(/scans the raw request headers/)).toBeInTheDocument();
  });

  it("commits a header search on blur (NOT debounced-as-you-type), as its own ?headerSearch= facet", async () => {
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Search request headers");
    await user.type(input, "  x-shopify-topic  ");
    // Typing alone must NOT push (unlike the debounced search box) — it commits only on Enter/blur.
    expect(replace).not.toHaveBeenCalled();
    await user.tab(); // blur → commit
    expect(replace).toHaveBeenCalled();
    const url = String(replace.mock.calls.at(-1)?.[0]);
    // Its OWN query param — never folded into ?search=; trimmed.
    expect(url).toContain("headerSearch=x-shopify-topic");
    expect(url).not.toContain("search=x-shopify"); // not merged into the fast search
    expect(input.value).toBe("x-shopify-topic");
  });

  it("accepts a 1-2 char header search (no trigram floor — the scan is unindexed)", async () => {
    // Unlike --search / the search box (min 3), header search has no floor: it's unindexed, so a short term
    // is valid (it just runs a slower scan). Committing "ab" must reach the URL.
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Search request headers");
    await user.type(input, "ab");
    await user.tab();
    expect(String(replace.mock.calls.at(-1)?.[0])).toContain("headerSearch=ab");
  });

  it("Clear filters wipes typed-but-uncommitted header-search text", async () => {
    mockSearch = "provider=stripe";
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Search request headers");
    await user.type(input, "x-shopify-topic");
    expect(input.value).toBe("x-shopify-topic");
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
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

  it("Clear immediately drops a just-selected facet, not a render or two later", async () => {
    // A multi-select facet is shown optimistically (pendingSel) before its RSC navigation commits. Clear must
    // reset that optimistic selection too — otherwise the just-picked chip stays checked (and Clear stays
    // enabled) until the navigation lands: the same chip-vs-data flash the free-text resets avoid.
    const user = userEvent.setup();
    render(<EventsFilterBar providers={["stripe"]} />);
    await user.click(screen.getByRole("button", { name: /Filter by HTTP method/ }));
    await user.click(screen.getByRole("option", { name: "GET" }));
    const clearBtn = screen.getByRole("button", { name: /Clear filters/ });
    expect(clearBtn).toBeEnabled(); // the method facet is the one active filter
    await user.click(clearBtn);
    // With the fix, the optimistic method selection is emptied on the same render — so with no other filter
    // set, Clear disables at once. Without it, methodSel would still read ['GET'] until the URL commits.
    expect(clearBtn).toBeDisabled();
  });

  it("Clear immediately clears a URL-sourced filter (endpoint/date), not just optimistic facets", async () => {
    // The uneven-clearing bug: earlier only the multi-selects cleared optimistically, while endpoint/date/the
    // Clear button kept reading raw searchParams and lagged the RSC round trip — a half-cleared bar. Routing
    // every read through viewParams (the last-pushed query) makes them all clear on the same render. Here the
    // only filter is a URL-sourced endpoint drill-down, which has no optimistic layer of its own.
    const EP = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
    mockSearch = `endpointId=${EP}`;
    const user = userEvent.setup();
    render(
      <EventsFilterBar
        providers={["stripe"]}
        endpoints={[{ id: EP, name: "stripe-prod", deleted: false }]}
      />,
    );
    const clearBtn = screen.getByRole("button", { name: /Clear filters/ });
    expect(clearBtn).toBeEnabled();
    await user.click(clearBtn);
    // Clear disables on the same render — endpointSel now reads the emptied viewParams, not the stale URL.
    expect(clearBtn).toBeDisabled();
  });

  it("an external nav recovers even after a no-op push pinned the optimistic query", async () => {
    // A no-op push — here choosing "All endpoints" when no endpoint is set — pushes an identical query, so
    // router.replace never changes committedQuery and the reset effect can't fire on the push: lastPushedRef
    // is left pinned. The reset MUST then fire unconditionally on the next real navigation, or viewParams
    // would keep driving every control from the abandoned query (a stale bar) after Back/forward.
    const EP = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
    const endpoints = [{ id: EP, name: "ep", deleted: false }];
    mockSearch = "provider=stripe";
    const user = userEvent.setup();
    const { rerender } = render(
      <EventsFilterBar providers={["stripe", "github"]} endpoints={endpoints} />,
    );
    // The provider trigger shows the active selection ("Stripe").
    expect(screen.getByRole("button", { name: /Filter by provider/ })).toHaveTextContent("Stripe");
    // No-op push: pick "All endpoints" while none is set → identical query → committedQuery unchanged.
    await user.click(screen.getByRole("button", { name: /Filter by endpoint/ }));
    await user.click(screen.getByRole("option", { name: "All endpoints" }));
    // External navigation (Back) to a different filter.
    mockSearch = "status=verified";
    rerender(<EventsFilterBar providers={["stripe", "github"]} endpoints={endpoints} />);
    // The bar reflects the NEW url — the stale provider override the no-op push pinned is gone.
    expect(screen.getByRole("button", { name: /Filter by provider/ })).toHaveTextContent(
      "All providers",
    );
  });

  // FINDING 1 (the chip-vs-data lie via URL, not just typed input): a shared link whose ?eventType= is
  // whitespace-only or over the max is DROPPED by the server parser, so the bar must not present it as an
  // applied filter. The box stays empty, Clear stays disabled, and the coverage hint stays hidden — the bar's
  // notion of "event-type filter active" is the exact predicate the server applies.
  it.each([
    ["whitespace-only", "eventType=%20%20"],
    ["over the max", `eventType=${"x".repeat(300)}`],
  ])(
    "a URL ?eventType that the server drops (%s) does not light the filter UI",
    (_label, query) => {
      mockSearch = query;
      render(<EventsFilterBar providers={["stripe"]} />);
      const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
      expect(input.value).toBe(""); // not the raw junk value
      expect(input).not.toHaveAttribute("aria-describedby"); // hint not linked
      expect(screen.queryByText(/parsed for some providers only/)).not.toBeInTheDocument();
      // Clear is disabled: no filter is actually applied, so there is nothing to clear.
      expect(screen.getByRole("button", { name: /Clear filters/ })).toBeDisabled();
    },
  );

  // OUR OWN COMMIT'S ECHO must not clobber in-flight typing. Characters typed AFTER a commit, while the
  // commit's RSC navigation is still in flight (the URL lags), survive when that navigation lands — because the
  // arriving URL value EQUALS what we last pushed (committedEventTypeRef), so the effect treats it as an echo,
  // not an external change, and doesn't overwrite the box.
  it("does not clobber characters typed during a commit's URL round-trip", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
    await user.type(input, "charge.succeeded");
    await user.keyboard("{Enter}"); // commit → pushes ?eventType=charge.succeeded (URL not yet updated)
    await user.type(input, ".v2"); // refine while the navigation is in flight
    expect(input.value).toBe("charge.succeeded.v2");
    // The Enter's navigation now lands: the URL catches up to the committed value.
    mockSearch = "eventType=charge.succeeded";
    rerender(<EventsFilterBar providers={["stripe"]} />);
    // The in-flight ".v2" must NOT have been overwritten by the URL→box re-sync.
    expect(input.value).toBe("charge.succeeded.v2");
  });

  // AN EXTERNAL NAVIGATION (back/forward/shared link) — a URL change we did NOT push — must be adopted into the
  // box, even over an uncommitted edit, so the box can't sit stale over freshly-navigated data. This is the
  // failure the removed self-never-healing "pending" latch caused: it suppressed the sync indefinitely.
  it("adopts an external ?eventType change into the box, discarding an uncommitted edit", () => {
    // Start with a committed event-type filter.
    mockSearch = "eventType=invoice.paid";
    const { rerender } = render(<EventsFilterBar providers={["stripe"]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Filter by event type");
    expect(input.value).toBe("invoice.paid");
    // The reader types into the box WITHOUT committing (no Enter/blur)…
    fireEvent.change(input, { target: { value: "cha" } });
    expect(input.value).toBe("cha");
    // …then navigates (Back/forward/link) to a DIFFERENT event-type state. The bar re-renders with the new URL.
    mockSearch = "eventType=charge.succeeded";
    rerender(<EventsFilterBar providers={["stripe"]} />);
    // The box reflects where they navigated — not the abandoned "cha", and not the old "invoice.paid".
    expect(input.value).toBe("charge.succeeded");
    // And a subsequent blur commits the ADOPTED value: it does not re-push the discarded "cha".
    const before = replace.mock.calls.length;
    fireEvent.blur(input);
    for (const call of replace.mock.calls.slice(before)) {
      expect(String(call[0])).not.toContain("cha&");
      expect(String(call[0])).not.toMatch(/eventType=cha(&|$)/);
    }
  });
});
