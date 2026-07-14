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
});
