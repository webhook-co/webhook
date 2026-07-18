import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { motion } from "../tokens";
import {
  columnsForFormat,
  SurfaceTabsView,
  underlineGlowOpacity,
  underlineSweepProgress,
} from "./SurfaceTabs";

const TABS = ["mcp", "cli", "api", "web"];

// columnsForFormat is the layout switch behind brief §8.1's "row (16:9) vs
// 2x2 grid (9:16)" requirement — getting it wrong either crams four tabs into
// two columns on the master, or leaves the vertical cut in an un-mobile-shaped
// single row.
describe("columnsForFormat", () => {
  it("lays every tab out in a single row for 16:9", () => {
    expect(columnsForFormat("16x9", 4)).toBe(4);
  });

  it("lays tabs out in a 2x2 grid for 9:16", () => {
    expect(columnsForFormat("9x16", 4)).toBe(2);
  });

  it("never asks for more columns than there are tabs, even vertically", () => {
    expect(columnsForFormat("9x16", 1)).toBe(1);
  });
});

// underlineSweepProgress is the shared-underline "sweeps the active surface"
// beat: it must rest at 0 before a tab becomes active, reach exactly 1 by the
// brief's cross-surface-rails duration, and never regress once swept in.
describe("underlineSweepProgress", () => {
  it("is 0 before and at the moment the tab becomes active", () => {
    expect(underlineSweepProgress(-5)).toBe(0);
    expect(underlineSweepProgress(0)).toBe(0);
  });

  it("reaches exactly 1 at the rails duration and holds there afterward", () => {
    expect(underlineSweepProgress(motion.railsDurationFrames)).toBe(1);
    expect(underlineSweepProgress(motion.railsDurationFrames + 100)).toBe(1);
  });

  it("is strictly between 0 and 1 partway through the sweep", () => {
    const mid = underlineSweepProgress(motion.railsDurationFrames / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("is monotonically non-decreasing across the sweep window (never a stutter back)", () => {
    let prev = -Infinity;
    for (let f = -2; f <= motion.railsDurationFrames + 2; f++) {
      const progress = underlineSweepProgress(f);
      expect(progress).toBeGreaterThanOrEqual(prev);
      prev = progress;
    }
  });

  it("honors a custom duration", () => {
    expect(underlineSweepProgress(10, 10)).toBe(1);
  });
});

// underlineGlowOpacity is the confirming flash on each surface swap: silent
// before the tab is active (never an unearned glow left over from a clamped
// negative input), peaks exactly on arrival, and decays monotonically.
describe("underlineGlowOpacity", () => {
  it("is 0 before the tab becomes active", () => {
    expect(underlineGlowOpacity(-1)).toBe(0);
    expect(underlineGlowOpacity(-100)).toBe(0);
  });

  it("peaks at exactly 1 the moment the tab becomes active", () => {
    expect(underlineGlowOpacity(0)).toBe(1);
  });

  it("decays monotonically after arrival and settles at 0", () => {
    let prev = underlineGlowOpacity(0);
    for (let f = 1; f <= motion.ringPulse.durationFrames; f++) {
      const opacity = underlineGlowOpacity(f);
      expect(opacity).toBeLessThanOrEqual(prev);
      prev = opacity;
    }
    expect(underlineGlowOpacity(motion.ringPulse.durationFrames + 500)).toBe(0);
  });
});

// SurfaceTabsView is the pure presentational half: only the active tab's
// underline should ever be visible — this is the "same event, every surface"
// continuity motif's whole job, so a stale underline left on the previous
// active tab (or two active at once) would break it silently.
describe("SurfaceTabsView", () => {
  it("renders every tab label byte-for-byte", () => {
    render(<SurfaceTabsView tabs={TABS} activeIndex={0} columns={4} sweep={1} glow={0} />);
    for (const label of TABS) {
      expect(screen.getByText(label).textContent).toBe(label);
    }
  });

  it("shows the swept-in underline only on the active tab", () => {
    render(<SurfaceTabsView tabs={TABS} activeIndex={1} columns={4} sweep={0.75} glow={0} />);
    for (const label of TABS) {
      const underline = screen.getByTestId(`surface-tab-underline-${label}`);
      if (label === TABS[1]) {
        expect(underline.style.transform).toBe("scaleX(0.75)");
        expect(underline.style.opacity).toBe("1");
      } else {
        expect(underline.style.transform).toBe("scaleX(0)");
        expect(underline.style.opacity).toBe("0");
      }
    }
  });

  it("moves the visible underline when activeIndex changes (no two tabs lit at once)", () => {
    const { rerender } = render(
      <SurfaceTabsView tabs={TABS} activeIndex={0} columns={4} sweep={1} glow={0} />,
    );
    expect(screen.getByTestId(`surface-tab-underline-${TABS[0]}`).style.opacity).toBe("1");
    expect(screen.getByTestId(`surface-tab-underline-${TABS[2]}`).style.opacity).toBe("0");

    rerender(<SurfaceTabsView tabs={TABS} activeIndex={2} columns={4} sweep={1} glow={0} />);
    expect(screen.getByTestId(`surface-tab-underline-${TABS[0]}`).style.opacity).toBe("0");
    expect(screen.getByTestId(`surface-tab-underline-${TABS[2]}`).style.opacity).toBe("1");
  });

  it("lays out in a single CSS-grid row when columns equals the tab count", () => {
    render(<SurfaceTabsView tabs={TABS} activeIndex={0} columns={4} sweep={1} glow={0} />);
    expect(screen.getByTestId("surface-tabs").style.gridTemplateColumns).toBe("repeat(4, auto)");
  });

  it("lays out in a 2x2 grid when columns is 2", () => {
    render(<SurfaceTabsView tabs={TABS} activeIndex={0} columns={2} sweep={1} glow={0} />);
    expect(screen.getByTestId("surface-tabs").style.gridTemplateColumns).toBe("repeat(2, auto)");
  });
});
