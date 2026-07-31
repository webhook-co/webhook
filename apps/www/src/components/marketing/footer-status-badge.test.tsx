import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { THIRD_PARTY_STATUS_BADGE } from "../../../playwright/axe-scope";

import { Footer } from "./footer";

// The hole the axe exclusion opened, closed.
//
// `apps/www/playwright/axe-scope.ts` excludes the Phare status-badge iframes from the accessibility
// audit, because axe walks INTO frames and a violation inside a vendor's cross-origin document is not
// something we can fix — it just reds the whole suite, ~55 tests at once, three times in two days.
//
// That exclusion is right, but `.exclude()` drops the element AND its subtree, so axe no longer checks
// the one thing about those iframes that IS ours: the `title` on the element itself. Delete the title
// tomorrow and the suite stays green, having been told not to look. An exemption is only as safe as
// whatever replaces what it gave up — this is that replacement.
describe("footer status badge", () => {
  it("gives every status-badge iframe a title, which axe no longer checks for us", () => {
    const { container } = render(<Footer />);
    const badges = container.querySelectorAll(THIRD_PARTY_STATUS_BADGE);

    // Anti-vacuity: if the selector stopped matching — a vendor change, a moved embed — this test would
    // pass by finding nothing, exactly when it most needs to fail. Two variants: light and dark.
    expect(badges.length).toBe(2);

    for (const badge of badges) {
      expect(badge.getAttribute("title")?.trim()).toBeTruthy();
    }
  });

  it("uses the same selector the audit excludes, so the two cannot drift apart", () => {
    // If the exclusion were widened to `iframe` or narrowed to one theme variant, this test would keep
    // asserting the old shape and the gap would reopen silently. Sharing the constant is what prevents
    // that: the thing we exempt and the thing we guard are one string.
    expect(THIRD_PARTY_STATUS_BADGE).toContain("status.webhook.co");
    const { container } = render(<Footer />);
    expect(container.querySelectorAll("iframe").length).toBe(
      container.querySelectorAll(THIRD_PARTY_STATUS_BADGE).length,
    );
  });
});
