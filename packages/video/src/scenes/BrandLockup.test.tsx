import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLockupView } from "./BrandLockup";

// BrandLockupView is the pure presentational half of the adapter: it takes the
// animation value as a prop instead of reading Remotion's useCurrentFrame(), so it
// renders like any other React component — no Remotion composition context required.
describe("BrandLockupView", () => {
  it("renders the real @webhook-co/ui Wordmark unchanged", () => {
    const { container } = render(<BrandLockupView enter={1} />);

    // Wordmark (packages/ui/src/components/mark.tsx) splits its own text across two
    // nodes — "webhook" as the parent span's direct text, ".co" as a nested de-emphasized
    // span — so no single element's own text is the combined string "webhook.co". Assert
    // the same way Wordmark's own test suite does (packages/ui/src/components/mark.test.tsx).
    expect(screen.getByText(/webhook/)).toBeTruthy();
    expect(screen.getByText(".co")).toBeTruthy();

    // The lockup's leading Mark renders as an svg labeled "webhook.co". Wordmark marks it
    // aria-hidden (the visible text already carries the accessible name for assistive
    // tech), which also makes its accessible-name computation resolve to "" — so query it
    // directly rather than via getByRole. Confirms the full lockup (mark + wordmark), not
    // just the text, made it through the adapter.
    const mark = container.querySelector('svg[aria-label="webhook.co"]');
    expect(mark).not.toBeNull();
  });

  it("clamps opacity to the wordmark's fully-visible state once enter reaches 1", () => {
    render(<BrandLockupView enter={1} />);
    const wordmark = screen.getByText(/webhook/).closest("[style]") as HTMLElement | null;
    expect(wordmark).not.toBeNull();
    expect(wordmark?.style.opacity).toBe("1");
  });
});
