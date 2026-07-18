import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colors } from "../tokens";
import { EventRowView } from "./EventRow";

const baseBadgeMotion = { opacity: 1, scale: 1, glowOpacity: 0 };

// EventRow's own logic is the row scale/highlight wiring + delegating state to
// the composed badge's color mapping — test the pure View directly (mirrors
// the TypedLine/TerminalIsland/VerifiedBadge split in this package).
describe("EventRowView", () => {
  it("renders the received, provider, and id fields byte-for-byte", () => {
    render(
      <EventRowView
        received="2026-07-12T14:02:11.840Z"
        provider="linear"
        state="verified"
        id="0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );

    expect(screen.getByTestId("event-row-received").textContent).toBe("2026-07-12T14:02:11.840Z");
    expect(screen.getByTestId("event-row-provider").textContent).toBe("linear");
    expect(screen.getByTestId("event-row-id").textContent).toBe(
      "0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21",
    );
  });

  it("state drives the composed badge's color (verified → green dot)", () => {
    const { container } = render(
      <EventRowView
        received="2026-07-12T14:02:11.840Z"
        provider="linear"
        state="verified"
        id="0197f0c1-..."
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const dot = container.querySelector('[data-testid="event-row"] > div > span') as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.verified));
  });

  it("state drives the composed badge's color (failed → red dot)", () => {
    const { container } = render(
      <EventRowView
        received="2026-07-12T14:03:02.902Z"
        provider="gitlab"
        state="failed"
        id="0197f0c3-..."
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const dot = container.querySelector('[data-testid="event-row"] > div > span') as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.failed));
  });

  it("state drives the composed badge's color (authenticated → amber dot)", () => {
    const { container } = render(
      <EventRowView
        received="2026-07-12T14:03:02.902Z"
        provider="gitlab"
        state="authenticated"
        id="0197f0c3-..."
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const dot = container.querySelector('[data-testid="event-row"] > div > span') as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.authenticated));
  });

  it("applies the row-level overshoot scale as a CSS transform", () => {
    render(
      <EventRowView
        received="r"
        provider="p"
        state="verified"
        id="i"
        scale={1.06}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const row = screen.getByTestId("event-row");
    expect(row.style.transform).toBe("scale(1.06)");
  });

  it("has no --wire underline when not highlighted", () => {
    render(
      <EventRowView
        received="r"
        provider="p"
        state="verified"
        id="i"
        scale={1}
        badgeMotion={baseBadgeMotion}
      />,
    );
    const row = screen.getByTestId("event-row");
    expect(row.style.borderBottomColor).toBe("transparent");
  });

  it("draws the --wire underline when highlighted", () => {
    render(
      <EventRowView
        received="r"
        provider="p"
        state="verified"
        id="i"
        scale={1}
        highlight
        badgeMotion={baseBadgeMotion}
      />,
    );
    const row = screen.getByTestId("event-row");
    expect(row.style.borderBottomColor).toBe(hexToRgbaWire());
  });

  it("passes the composed badge's pop scale/glow through unchanged", () => {
    const { container } = render(
      <EventRowView
        received="r"
        provider="p"
        state="verified"
        id="i"
        scale={1}
        highlight
        badgeMotion={{ opacity: 1, scale: 1.06, glowOpacity: 1 }}
      />,
    );
    const badgeRoot = container.querySelector(
      '[data-testid="event-row"] > span:nth-child(3)',
    ) as HTMLElement | null;
    // The badge is the third child of the row grid (received, provider, badge, id).
    const badge =
      badgeRoot ?? (container.querySelectorAll('[data-testid="event-row"] > *')[2] as HTMLElement);
    expect(badge.style.transform).toBe("scale(1.06)");
  });
});

/** Converts a `#RRGGBB` hex string to the `rgb(r, g, b)` form jsdom serializes inline styles to. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** `colors.wire` is `rgba(63,178,127,0.35)` — jsdom re-serializes with spaces after commas. */
function hexToRgbaWire(): string {
  return "rgba(63, 178, 127, 0.35)";
}
