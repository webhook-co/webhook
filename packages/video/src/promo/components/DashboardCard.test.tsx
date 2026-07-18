import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colors } from "../tokens";
import { DashboardCardView } from "./DashboardCard";

const baseBadgeMotion = { opacity: 1, scale: 1, glowOpacity: 0 };

// DashboardCard's own logic is the card land scale + delegating state to the
// composed badge's color mapping — test the pure View directly (mirrors the
// EventRow/TerminalIsland/VerifiedBadge split in this package).
describe("DashboardCardView", () => {
  it("renders the provider, received, and id fields byte-for-byte", () => {
    render(
      <DashboardCardView
        provider="linear"
        received="2026-07-12T14:02:11.840Z"
        id="0197f0c1-..."
        state="verified"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );

    expect(screen.getByTestId("dashboard-card-provider").textContent).toBe("linear");
    expect(screen.getByTestId("dashboard-card-received").textContent).toBe(
      "2026-07-12T14:02:11.840Z",
    );
    expect(screen.getByTestId("dashboard-card-id").textContent).toBe("0197f0c1-...");
  });

  it("renders the composed badge's state label", () => {
    render(
      <DashboardCardView
        provider="linear"
        received="2026-07-12T14:02:11.840Z"
        id="0197f0c1-..."
        state="verified"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    expect(screen.getByText("verified")).toBeTruthy();
  });

  it("state drives the composed badge's color (verified → green dot)", () => {
    const { container } = render(
      <DashboardCardView
        provider="linear"
        received="2026-07-12T14:02:11.840Z"
        id="0197f0c1-..."
        state="verified"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const dot = container.querySelector(
      '[data-testid="dashboard-card-provider"] + div > span',
    ) as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.verified));
  });

  it("state drives the composed badge's color (failed → red dot)", () => {
    const { container } = render(
      <DashboardCardView
        provider="gitlab"
        received="2026-07-12T14:03:02.902Z"
        id="0197f0c3-..."
        state="failed"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const dot = container.querySelector(
      '[data-testid="dashboard-card-provider"] + div > span',
    ) as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.failed));
  });

  it("renders on the light-mode page-panel surface with a page-border hairline", () => {
    render(
      <DashboardCardView
        provider="linear"
        received="2026-07-12T14:02:11.840Z"
        id="0197f0c1-..."
        state="verified"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const card = screen.getByTestId("dashboard-card");
    expect(card.style.backgroundColor).toBe(hexToRgb(colors.pagePanel));
    expect(card.style.border).toBe(`1px solid ${hexToRgb(colors.pageBorder)}`);
  });

  it("applies the card-level overshoot scale as a CSS transform", () => {
    render(
      <DashboardCardView
        provider="linear"
        received="2026-07-12T14:02:11.840Z"
        id="0197f0c1-..."
        state="verified"
        scale={1.06}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const card = screen.getByTestId("dashboard-card");
    expect(card.style.transform).toBe("scale(1.06)");
  });
});

/** Converts a `#RRGGBB` hex string to the `rgb(r, g, b)` form jsdom serializes inline styles to. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
