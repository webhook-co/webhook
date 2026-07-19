import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CardsPageSkeleton, ListPageSkeleton, TableSkeleton } from "./page-skeletons";

// A loading.tsx renders INSTANTLY on navigation, before the server render returns — the whole point being that
// the user sees the page's shape immediately instead of a blank frame. So the one thing that must be true is
// that it announces itself to assistive tech (the visual shimmer says nothing to a screen reader).
describe("page skeletons", () => {
  it("announces the list page as busy and names what is loading", () => {
    render(<ListPageSkeleton label="endpoints" />);
    expect(screen.getByText(/loading endpoints/i)).toBeInTheDocument();
  });

  it("announces the cards page too", () => {
    render(<CardsPageSkeleton label="billing" />);
    expect(screen.getByText(/loading billing/i)).toBeInTheDocument();
  });

  // The skeleton must MIRROR the page it stands in for, or the content jumps when it arrives — which is worse
  // than no skeleton, because the reflow draws the eye. A table page gets a table's worth of rows.
  it("renders the requested rows and columns", () => {
    const { container } = render(<TableSkeleton rows={5} columns={4} />);
    // header strip + 5 rows, each with 4 cells
    const cells = container.querySelectorAll("[aria-hidden]");
    expect(cells.length).toBe(4 + 5 * 4);
  });

  // Matching the page's shape is not just about the cards — it's the COLUMN too. The narrow settings/account
  // pages use `PageContainer size="narrow"` (760px) with `gap-6`; a skeleton stuck at the default 860px/gap-8
  // is 100px too wide and re-flows the whole column inward the instant the real content lands. So the wrapper
  // must forward the page's own container width and rhythm.
  it("forwards the container width and gap so the column doesn't jump", () => {
    const { container } = render(
      <CardsPageSkeleton label="settings" size="narrow" gap="gap-6" cards={2} />,
    );
    expect(container.firstChild).toHaveClass("max-w-[760px]");
    expect(container.firstChild).toHaveClass("gap-6");
    // Two cards to mirror the two panels the settings page renders.
    expect(container.querySelectorAll(".rounded-card")).toHaveLength(2);
  });

  it("keeps the default width and rhythm when no size/gap is given", () => {
    const { container } = render(<CardsPageSkeleton label="dashboard" />);
    expect(container.firstChild).toHaveClass("max-w-[860px]");
    expect(container.firstChild).toHaveClass("gap-8");
  });

  it("forwards width and gap on the list skeleton too", () => {
    const { container } = render(<ListPageSkeleton label="events" size="narrow" gap="gap-6" />);
    expect(container.firstChild).toHaveClass("max-w-[760px]");
    expect(container.firstChild).toHaveClass("gap-6");
  });
});
