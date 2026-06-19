import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { AppNavItem, AppNavSection, AppShell } from "./app-shell";

function Example(props: Partial<React.ComponentProps<typeof AppShell>> = {}) {
  return (
    <AppShell
      sidebar={
        <>
          <AppNavSection>Workspace</AppNavSection>
          <AppNavItem href="/overview" active count={24}>
            Overview
          </AppNavItem>
          <AppNavItem href="/events">Events</AppNavItem>
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

  it("renders the webhook.co lockup", () => {
    render(<Example />);
    expect(screen.getByText(/webhook/)).toBeInTheDocument();
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

  it("forwards a ref", () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <AppNavItem href="/o" ref={ref}>
        Overview
      </AppNavItem>,
    );
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
  });
});

describe("AppNavSection", () => {
  it("renders a section label", () => {
    render(<AppNavSection>Account</AppNavSection>);
    expect(screen.getByText("Account")).toBeInTheDocument();
  });
});
