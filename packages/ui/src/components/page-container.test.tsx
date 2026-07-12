import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState, PageContainer, PageHeader } from "./page-container";

// These primitives replace a container className copy-pasted across 14 dashboard pages (and MISSING on the
// billing page — the width bug this fixes). Their whole contract IS the composed class output, so asserting
// the className at the component boundary is legitimate here (unlike a page-level jsdom class check, which
// proves nothing about the cascade). The exact tokens are pinned because a drift silently changes every page.

describe("PageContainer", () => {
  it("applies the standard centered, max-width, padded container (the shape 12 pages copy-paste)", () => {
    const { container } = render(<PageContainer>x</PageContainer>);
    const root = container.firstElementChild!;
    for (const cls of ["mx-auto", "flex", "max-w-[860px]", "flex-col", "gap-8", "p-8"]) {
      expect(root).toHaveClass(cls);
    }
  });

  it("supports the narrow width for settings-style pages (was max-w-[760px])", () => {
    const { container } = render(<PageContainer size="narrow">x</PageContainer>);
    expect(container.firstElementChild).toHaveClass("max-w-[760px]");
    expect(container.firstElementChild).not.toHaveClass("max-w-[860px]");
  });

  it("lets a caller override the gap without losing the container (billing used gap-6)", () => {
    const { container } = render(<PageContainer gap="gap-6">x</PageContainer>);
    const root = container.firstElementChild!;
    expect(root).toHaveClass("gap-6", "mx-auto", "max-w-[860px]");
    expect(root).not.toHaveClass("gap-8"); // tailwind-merge dropped the conflicting default
  });

  it("merges a caller className (cn/tailwind-merge), and renders children", () => {
    render(
      <PageContainer className="bg-surface" data-testid="pc">
        <span>hello</span>
      </PageContainer>,
    );
    const el = screen.getByTestId("pc");
    expect(el).toHaveClass("bg-surface", "mx-auto");
    expect(el).toHaveTextContent("hello");
  });
});

describe("PageHeader", () => {
  it("renders the title as an h1 and the description", () => {
    render(<PageHeader title="Billing" description="Your plan, payment, and invoices." />);
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toBeInTheDocument();
    expect(screen.getByText("Your plan, payment, and invoices.")).toBeInTheDocument();
  });

  it("omits the description paragraph when none is given (settings-style title-only header)", () => {
    render(<PageHeader title="Settings" />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    // No stray empty paragraph.
    expect(document.querySelectorAll("p")).toHaveLength(0);
  });

  it("renders a back link above the title when backHref is given (detail pages)", () => {
    render(<PageHeader title="My endpoint" backHref="/endpoints" backLabel="Endpoints" />);
    const back = screen.getByRole("link", { name: /Endpoints/ });
    expect(back).toHaveAttribute("href", "/endpoints");
  });

  it("renders an actions slot alongside the title (e.g. a Create button)", () => {
    render(<PageHeader title="Endpoints" actions={<button>Create endpoint</button>} />);
    expect(screen.getByRole("button", { name: "Create endpoint" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders a title, an optional description, and an optional action, standalone (not table-bound)", () => {
    render(
      <EmptyState
        title="No endpoints yet"
        description="Create one to start receiving webhooks."
        action={<button>Send a test webhook</button>}
      />,
    );
    expect(screen.getByText("No endpoints yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to start receiving webhooks.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a test webhook" })).toBeInTheDocument();
    // Standalone (not a <td> like TableEmpty) — safe to drop anywhere in a page.
    expect(document.querySelector("td")).toBeNull();
  });
});
