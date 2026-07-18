import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { activeNavKey, AppNav, COMMAND_ITEMS, NAV, orgHref } from "./app-nav";

const SLUG = "acme";
const EP = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EV = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

let pathname = `/org/${SLUG}/dashboard`;
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

describe("activeNavKey", () => {
  // THE TRAP, as a table. A per-item `startsWith` rule lights up ENDPOINTS for the per-endpoint events list
  // (it starts with /endpoints) — so a reader looking at events sees the sidebar claim they are somewhere
  // else. Both events routes must claim the events key.
  it.each([
    [`/org/${SLUG}/dashboard`, "overview"],
    [`/org/${SLUG}/endpoints`, "endpoints"],
    [`/org/${SLUG}/endpoints/${EP}`, "endpoints"],
    [`/org/${SLUG}/endpoints/${EP}/settings`, "endpoints"],
    [`/org/${SLUG}/events`, "events"],
    // the per-endpoint events list + detail — the trap
    [`/org/${SLUG}/endpoints/${EP}/events`, "events"],
    [`/org/${SLUG}/endpoints/${EP}/events/${EV}`, "events"],
    [`/org/${SLUG}/deliveries`, "deliveries"],
    [`/org/${SLUG}/settings`, "settings"],
  ])("%s → %s", (path, expected) => {
    expect(activeNavKey(path, SLUG)).toBe(expected);
  });

  it("returns null outside the org (and never guesses)", () => {
    expect(activeNavKey("/login", SLUG)).toBeNull();
    expect(activeNavKey(`/org/other/events`, SLUG)).toBeNull();
  });

  // The invariant the single-key design buys, asserted on the RENDERED nav rather than the function: no route
  // may light two rows, and none may light zero.
  it.each([
    [`/org/${SLUG}/events`, "Events"],
    [`/org/${SLUG}/endpoints/${EP}/events`, "Events"],
    [`/org/${SLUG}/endpoints`, "Endpoints"],
    [`/org/${SLUG}/dashboard`, "Overview"],
  ])("on %s exactly one nav item is aria-current, and it is %s", (path, label) => {
    pathname = path;
    render(<AppNav slug={SLUG} />);
    const current = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
  });
});

describe("COMMAND_ITEMS (⌘K)", () => {
  // app-nav.tsx warns that a page in the sidebar but not the palette is "drift nobody notices until a user
  // complains" — but nothing enforced it. Now adding a NAV entry without a palette entry is a red build.
  it("covers every NAV entry", () => {
    expect(
      COMMAND_ITEMS(SLUG)
        .map((i) => i.href)
        .sort(),
    ).toEqual(
      Object.values(NAV)
        .map((n) => orgHref(SLUG, n.path))
        .sort(),
    );
  });

  // Typing a page's own name must find it. NAV.usage used to own the "events" keyword, so ⌘K → "events"
  // landed on Usage and the events page was unreachable by name.
  it('"events" resolves to the Events page, not Usage', () => {
    const hits = COMMAND_ITEMS(SLUG).filter((i) => i.keywords.includes("events"));
    expect(hits).toHaveLength(1);
    expect(hits[0].href).toBe(orgHref(SLUG, "/events"));
  });
});

// The SEMANTIC WIRING at the real call site (#20). The ui-package primitives are proven in isolation, but a
// regression that flattens Events back to a flat sibling of Endpoints — reintroducing the exact a11y bug #20
// fixes — lives HERE, in how app-nav composes the primitives. These tests lock that composition: Events must
// be Endpoints' nested child, and each section must be a real labeled group. They render `<AppNav>` inside a
// `<ul>` because that is precisely what AppShell wraps the sidebar in (`<nav><ul role="list">…`); the wrapper
// stands in for that owner so the top-level list is a real reference point.
describe("AppNav semantic list wiring", () => {
  const wrapInList = ({ children }: { children: ReactNode }) => <ul>{children}</ul>;

  it("nests Events as a true child of Endpoints — not a flat sibling", () => {
    pathname = `/org/${SLUG}/dashboard`;
    const { container } = render(<AppNav slug={SLUG} />, { wrapper: wrapInList });
    const topList = container.querySelector("ul"); // the outermost <ul> — AppShell's owner list

    const endpoints = screen.getByRole("link", { name: "Endpoints" });
    const events = screen.getByRole("link", { name: "Events" });

    const endpointsItem = endpoints.closest("li");
    const eventsItem = events.closest("li");
    // Events' <li> is a DESCENDANT of Endpoints' <li>, so AT announces it as a child. A flat sibling would
    // fail this — which is the whole regression this test exists to catch.
    expect(endpointsItem).toContainElement(eventsItem);
    expect(eventsItem).not.toBe(endpointsItem);

    // …and it reaches that item through a nested `<ul role="list">` that is not the top-level nav list.
    const nested = events.closest("ul");
    expect(nested).toHaveAttribute("role", "list");
    expect(nested).not.toBe(topList);
    expect(endpointsItem).toContainElement(nested);
  });

  it("groups each section as a labeled list that owns its links", () => {
    pathname = `/org/${SLUG}/dashboard`;
    render(<AppNav slug={SLUG} />, { wrapper: wrapInList });

    // Each section name is the accessible name of the list its items live in (via aria-labelledby). A
    // decorative sibling heading that grouped nothing would make these queries find no such list.
    const inbound = screen.getByRole("list", { name: "Inbound" });
    expect(within(inbound).getByRole("link", { name: "Endpoints" })).toBeInTheDocument();
    expect(within(inbound).getByRole("link", { name: "Triggers" })).toBeInTheDocument();

    const outbound = screen.getByRole("list", { name: "Outbound" });
    expect(within(outbound).getByRole("link", { name: "Destinations" })).toBeInTheDocument();
    expect(within(outbound).getByRole("link", { name: "Deliveries" })).toBeInTheDocument();

    const account = screen.getByRole("list", { name: "Account" });
    expect(within(account).getByRole("link", { name: "Usage" })).toBeInTheDocument();
    expect(within(account).getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});
