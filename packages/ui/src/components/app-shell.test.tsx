import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppNavItem, AppNavSection, AppShell } from "./app-shell";

function Example(props: Partial<React.ComponentProps<typeof AppShell>> = {}) {
  return (
    <AppShell
      sidebar={
        <>
          <AppNavItem href="/overview" active count={24}>
            Overview
          </AppNavItem>
          <AppNavSection label="Inbound">
            <AppNavItem
              href="/endpoints"
              subNav={
                <AppNavItem href="/events" nested>
                  Events
                </AppNavItem>
              }
            >
              Endpoints
            </AppNavItem>
          </AppNavSection>
        </>
      }
      topBar={<span>breadcrumbs</span>}
      {...props}
    >
      <h1>Overview page</h1>
    </AppShell>
  );
}

describe("AppShell", () => {
  it("renders the main content", () => {
    render(<Example />);
    expect(screen.getByRole("heading", { name: "Overview page" })).toBeInTheDocument();
  });

  it("exposes main, navigation, and banner landmarks", () => {
    render(<Example />);
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Overview page" }),
    );
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("breadcrumbs");
  });

  // The nesting is now SEMANTIC, not visual-only: the nav is a real list (#20). `role="list"` is set
  // explicitly because Tailwind's `list-style:none` reset otherwise strips list semantics in Safari+VoiceOver.
  it("wraps the nav in a real list, and every list carries an explicit role", () => {
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const lists = within(nav).getAllByRole("list");
    expect(lists.length).toBeGreaterThan(0);
    // Every <ul> we emit keeps role="list" so the semantics survive the list-style reset.
    for (const ul of nav.querySelectorAll("ul")) {
      expect(ul).toHaveAttribute("role", "list");
    }
  });

  it("nests the Events sub-item inside a list under the Endpoints item — a true DOM child", () => {
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const endpoints = within(nav).getByRole("link", { name: "Endpoints" });
    const events = within(nav).getByRole("link", { name: "Events" });

    const endpointsItem = endpoints.closest("li");
    const eventsItem = events.closest("li");
    expect(endpointsItem).not.toBeNull();
    expect(eventsItem).not.toBeNull();
    // Events' <li> is a descendant of Endpoints' <li> — not a sibling.
    expect(endpointsItem).toContainElement(eventsItem);
    expect(eventsItem).not.toBe(endpointsItem);

    // …and Events reaches that item through a NESTED <ul> that is not the top-level list Endpoints sits in.
    const eventsList = events.closest("ul");
    const endpointsList = endpoints.closest("ul");
    expect(endpointsItem).toContainElement(eventsList);
    expect(eventsList).not.toBe(endpointsList);
  });

  it("turns each section into a labeled group whose name is associated with its items", () => {
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    // The section label ("Inbound") is the accessible name of the list its items live in.
    const inbound = within(nav).getByRole("list", { name: "Inbound" });
    expect(within(inbound).getByRole("link", { name: "Endpoints" })).toBeInTheDocument();
  });

  it("keeps exactly one item marked as the current page", () => {
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const current = within(nav)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName(/Overview/);
  });

  // The lockup is OPT-IN now: it renders only when a `homeHref` is given. The dashboard deliberately gives
  // none, because the ORG PICKER takes the top-left corner instead — that corner is the most valuable space in
  // the shell, and "which organization am I in?" is the question you need answered before any other. A
  // wordmark there answers a question nobody was asking.
  //
  // Kept as a capability rather than deleted, because AppShell is a generic primitive and a surface that DOES
  // want a wordmark still can.
  it("renders the webhook.co lockup when a homeHref is given", () => {
    render(<Example homeHref="/" />);
    expect(screen.getByRole("link", { name: /webhook\.co home/i })).toBeInTheDocument();
  });

  it("renders NO lockup without a homeHref, leaving the corner to sidebarTop", () => {
    render(<Example sidebarTop={<button>Acme Corp</button>} />);

    expect(screen.queryByRole("link", { name: /webhook\.co home/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acme Corp" })).toBeInTheDocument();
  });

  it("renders the sidebarTop and sidebarFooter slots", () => {
    render(
      <Example sidebarTop={<button>Acme Corp</button>} sidebarFooter={<button>Dana K</button>} />,
    );
    expect(screen.getByRole("button", { name: "Acme Corp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dana K" })).toBeInTheDocument();
  });

  it("links the lockup home when homeHref is set", () => {
    render(<Example homeHref="/" />);
    expect(screen.getByRole("link", { name: "webhook.co home" })).toHaveAttribute("href", "/");
  });

  it("omits the banner when no topBar is given", () => {
    render(<AppShell sidebar={<AppNavItem href="/x">X</AppNavItem>}>content</AppShell>);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("does not render the mobile drawer by default", () => {
    render(<Example />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a focus-trapped drawer with the nav when sidebarOpen is true", () => {
    render(<Example sidebarOpen onSidebarOpenChange={() => {}} />);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("requests close on Escape", async () => {
    const onSidebarOpenChange = vi.fn();
    render(<Example sidebarOpen onSidebarOpenChange={onSidebarOpenChange} />);
    await userEvent.keyboard("{Escape}");
    expect(onSidebarOpenChange).toHaveBeenCalledWith(false);
  });

  it("requests close when the drawer close button is clicked", async () => {
    const onSidebarOpenChange = vi.fn();
    render(<Example sidebarOpen onSidebarOpenChange={onSidebarOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onSidebarOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("AppNavItem", () => {
  it("renders a link with its label, icon, and count", () => {
    render(
      <AppNavItem href="/events" count={42} icon={<svg data-testid="ic" />}>
        Events
      </AppNavItem>,
    );
    const link = screen.getByRole("link", { name: /events/i });
    expect(link).toHaveAttribute("href", "/events");
    expect(link).toHaveTextContent("42");
    expect(screen.getByTestId("ic")).toBeInTheDocument();
  });

  it("wraps the link in a list item", () => {
    render(<AppNavItem href="/events">Events</AppNavItem>);
    expect(screen.getByRole("link", { name: "Events" }).closest("li")).not.toBeNull();
  });

  it("marks the active item with aria-current=page", () => {
    render(
      <AppNavItem href="/o" active>
        Overview
      </AppNavItem>,
    );
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("is not current when inactive", () => {
    render(<AppNavItem href="/o">Overview</AppNavItem>);
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("forwards a ref to the anchor", () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <AppNavItem href="/o" ref={ref}>
        Overview
      </AppNavItem>,
    );
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
  });
});

// Sub-items (#20). A parent entry owns its children by passing them as `subNav`; they render in a nested
// `<ul role="list">` INSIDE the parent's own `<li>`, so assistive tech announces them as children — the
// nesting is structural, not a visual indent bolted onto a flat sibling.
describe("AppNavItem subNav", () => {
  it("renders sub-items in a nested list inside its own list item", () => {
    render(
      <ul>
        <AppNavItem
          href="/endpoints"
          subNav={
            <AppNavItem href="/events" nested>
              Events
            </AppNavItem>
          }
        >
          Endpoints
        </AppNavItem>
      </ul>,
    );
    const endpoints = screen.getByRole("link", { name: "Endpoints" });
    const events = screen.getByRole("link", { name: "Events" });

    const endpointsItem = endpoints.closest("li");
    expect(endpointsItem).toContainElement(events);

    const nested = events.closest("ul");
    expect(nested).toHaveAttribute("role", "list");
    expect(endpointsItem).toContainElement(nested);
    // The nested list is not the outer list Endpoints itself sits in.
    expect(nested).not.toBe(endpoints.closest("ul"));
  });
});

describe("AppNavSection", () => {
  it("renders a labeled group whose name is associated with its items", () => {
    render(
      <ul>
        <AppNavSection label="Account">
          <AppNavItem href="/settings">Settings</AppNavItem>
        </AppNavSection>
      </ul>,
    );
    expect(screen.getByText("Account")).toBeInTheDocument();
    const group = screen.getByRole("list", { name: "Account" });
    expect(within(group).getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});

// AppNavItem `asChild` (Lane 0.2). Without it the sidebar can only emit bare <a> tags — and every nav click
// is then a FULL DOCUMENT NAVIGATION: the whole app shell torn down, re-fetched and re-rendered, with client
// state discarded. `asChild` is what lets a router link (next/link) carry the nav styling instead.
describe("AppNavItem asChild", () => {
  it("renders the CHILD element, not a wrapper anchor, and keeps the nav semantics", () => {
    render(
      <AppNavItem asChild active icon={<svg data-testid="icon" />} count={3}>
        <a href="/x" data-testid="router-link">
          Endpoints
        </a>
      </AppNavItem>,
    );

    const link = screen.getByTestId("router-link");
    // The child IS the element — not nested inside another <a> (which would be invalid HTML and would
    // defeat the router entirely).
    expect(link.tagName).toBe("A");
    expect(document.querySelectorAll("a")).toHaveLength(1);

    // …and it still carries everything the nav item provides.
    expect(link).toHaveAttribute("aria-current", "page");
    // The count is announced as its own clause, not glued onto the page name ("Endpoints3").
    expect(link).toHaveAccessibleName("Endpoints, 3");
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // …and still rendered visually
  });

  it("still renders a plain anchor when asChild is not used", () => {
    render(<AppNavItem href="/y">Deliveries</AppNavItem>);
    expect(screen.getByRole("link", { name: "Deliveries" })).toHaveAttribute("href", "/y");
  });
});
