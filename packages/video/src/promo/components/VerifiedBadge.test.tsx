import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colors } from "../tokens";
import {
  badgeFadeInOpacity,
  badgeGlowOpacity,
  badgePopScale,
  stateColor,
  VerifiedBadgeView,
} from "./VerifiedBadge";

// The real logic in VerifiedBadge is the state → color mapping + the pop/glow
// motion curves — test them directly as pure functions, then confirm the pure
// View renders whatever it's handed (mirrors the TypedLine/TerminalIsland split).
describe("stateColor", () => {
  it("maps verified to the --verified green token", () => {
    expect(stateColor("verified")).toBe(colors.verified);
  });

  it("maps authenticated to the --authenticated amber token", () => {
    expect(stateColor("authenticated")).toBe(colors.authenticated);
  });

  it("maps failed to the --failed red token", () => {
    expect(stateColor("failed")).toBe(colors.failed);
  });

  it("maps unattempted to the --unattempted grey token", () => {
    expect(stateColor("unattempted")).toBe(colors.unattempted);
  });
});

describe("badgeFadeInOpacity", () => {
  it("is fully transparent before the entrance begins", () => {
    expect(badgeFadeInOpacity(-5)).toBe(0);
    expect(badgeFadeInOpacity(0)).toBe(0);
  });

  it("reaches full opacity by frame 10", () => {
    expect(badgeFadeInOpacity(10)).toBe(1);
  });

  it("never exceeds full opacity once settled", () => {
    expect(badgeFadeInOpacity(200)).toBe(1);
  });
});

describe("badgePopScale", () => {
  const fps = 30;

  it("starts at the 1.06 overshoot value before/at the pop frame", () => {
    expect(badgePopScale(-5, fps)).toBeCloseTo(1.06, 4);
    expect(badgePopScale(0, fps)).toBeCloseTo(1.06, 4);
  });

  it("settles to 1.0 well after the pop", () => {
    expect(badgePopScale(60, fps)).toBeCloseTo(1, 2);
  });
});

describe("badgeGlowOpacity", () => {
  it("starts at full glow intensity at the pop frame", () => {
    expect(badgeGlowOpacity(0)).toBe(1);
  });

  it("decays to zero by the ring-pulse duration (24 frames)", () => {
    expect(badgeGlowOpacity(24)).toBe(0);
  });

  it("never goes negative once fully decayed", () => {
    expect(badgeGlowOpacity(100)).toBe(0);
  });
});

describe("VerifiedBadgeView", () => {
  it("renders the lowercase state label", () => {
    render(<VerifiedBadgeView state="verified" opacity={1} scale={1} glowOpacity={0} />);
    expect(screen.getByText("verified")).toBeTruthy();
  });

  it("colors the dot green for a verified state", () => {
    const { container } = render(
      <VerifiedBadgeView state="verified" opacity={1} scale={1} glowOpacity={0} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.verified));
  });

  it("colors the dot amber for an authenticated state", () => {
    const { container } = render(
      <VerifiedBadgeView state="authenticated" opacity={1} scale={1} glowOpacity={0} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.authenticated));
  });

  it("colors the dot red for a failed state", () => {
    const { container } = render(
      <VerifiedBadgeView state="failed" opacity={1} scale={1} glowOpacity={0} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.failed));
  });

  it("colors the dot grey for an unattempted state", () => {
    const { container } = render(
      <VerifiedBadgeView state="unattempted" opacity={1} scale={1} glowOpacity={0} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.backgroundColor).toBe(hexToRgb(colors.unattempted));
  });

  it("applies no box-shadow when glowOpacity is 0", () => {
    const { container } = render(
      <VerifiedBadgeView state="verified" opacity={1} scale={1} glowOpacity={0} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.boxShadow).toBe("none");
  });

  it("applies the --verified-glow box-shadow while popping", () => {
    const { container } = render(
      <VerifiedBadgeView state="verified" opacity={1} scale={1.06} glowOpacity={1} />,
    );
    const dot = container.querySelector("span") as HTMLElement;
    expect(dot.style.boxShadow).toContain("24px");
  });

  it("reflects the entrance opacity and pop scale on the root element", () => {
    const { container } = render(
      <VerifiedBadgeView state="verified" opacity={0.5} scale={1.06} glowOpacity={0} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.opacity).toBe("0.5");
    expect(root.style.transform).toBe("scale(1.06)");
  });
});

/** Converts a `#RRGGBB` hex string to the `rgb(r, g, b)` form jsdom serializes inline styles to. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
