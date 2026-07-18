import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  itemSettleProgress,
  itemStartFrame,
  type TrustBandItem,
  TrustBandView,
  TrustIcon,
} from "./TrustBand";

const ITEMS: readonly TrustBandItem[] = [
  { icon: "github", label: "Open source" },
  { icon: "scale", label: "Apache-2.0" },
  { icon: "lock", label: "Private by default" },
];

// itemStartFrame is the per-item stagger behind the "settle in" beat — getting
// it wrong either collapses every item to one flat cut (no stagger) or drifts
// the reading order (later items landing before earlier ones).
describe("itemStartFrame", () => {
  it("starts the first item exactly on startFrame", () => {
    expect(itemStartFrame(0, 1740)).toBe(1740);
  });

  it("staggers each later item by the default 4 frames", () => {
    expect(itemStartFrame(1, 1740)).toBe(1744);
    expect(itemStartFrame(2, 1740)).toBe(1748);
  });

  it("honors a custom stagger", () => {
    expect(itemStartFrame(2, 1740, 10)).toBe(1760);
  });
});

// itemSettleProgress is the brief §3.4 headline-settle spring (no bounce) —
// must rest at 0 before/at the item's own start frame, rise monotonically
// with no overshoot, and settle at 1.
describe("itemSettleProgress", () => {
  const fps = 30;

  it("is 0 before the item begins settling", () => {
    expect(itemSettleProgress(-10, fps)).toBe(0);
    expect(itemSettleProgress(0, fps)).toBe(0);
  });

  it("rises monotonically toward 1 with no overshoot (no bounce)", () => {
    let prev = itemSettleProgress(0, fps);
    for (let f = 1; f <= 90; f++) {
      const progress = itemSettleProgress(f, fps);
      expect(progress).toBeGreaterThanOrEqual(prev);
      expect(progress).toBeLessThanOrEqual(1.001);
      prev = progress;
    }
  });

  it("settles at 1 well after the spring begins", () => {
    expect(itemSettleProgress(90, fps)).toBeCloseTo(1, 2);
  });
});

// TrustIcon is the small inline-SVG glyph set — every kind must render
// something distinguishable (a real <svg>, not silently nothing).
describe("TrustIcon", () => {
  it.each([
    ["lock", "trust-icon-lock"],
    ["scale", "trust-icon-scale"],
    ["github", "trust-icon-github"],
    ["hash-chain", "trust-icon-hash-chain"],
    ["layers", "trust-icon-layers"],
  ] as const)("renders the %s glyph", (kind, testId) => {
    render(<TrustIcon kind={kind} size={22} />);
    expect(screen.getByTestId(testId)).toBeTruthy();
  });
});

// TrustBandView is the pure presentational half — the whole job of this
// component is carrying the S20 close's real trust-fact strings byte-for-byte
// (brief §5 S20 / §6.1), staggered in without ever skipping an item.
describe("TrustBandView", () => {
  it("renders every item's label byte-for-byte", () => {
    render(<TrustBandView items={ITEMS} progresses={[1, 1, 1]} />);
    for (const item of ITEMS) {
      expect(screen.getByText(item.label).textContent).toBe(item.label);
    }
  });

  it("renders a middle-dot divider before every item after the first", () => {
    render(<TrustBandView items={ITEMS} progresses={[1, 1, 1]} />);
    const dots = screen.getAllByText("·");
    expect(dots).toHaveLength(ITEMS.length - 1);
  });

  it("renders one icon per item", () => {
    render(<TrustBandView items={ITEMS} progresses={[1, 1, 1]} />);
    expect(screen.getByTestId("trust-icon-github")).toBeTruthy();
    expect(screen.getByTestId("trust-icon-scale")).toBeTruthy();
    expect(screen.getByTestId("trust-icon-lock")).toBeTruthy();
  });

  it("keeps an unsettled (progress=0) item invisible and offset", () => {
    render(<TrustBandView items={ITEMS} progresses={[0, 1, 1]} />);
    const first = screen.getByTestId(`trust-item-${ITEMS[0]!.label}`);
    expect(first.style.opacity).toBe("0");
    expect(first.style.transform).toBe("translateY(12px)");
  });

  it("settles a fully-progressed item at full opacity and translateY(0)", () => {
    render(<TrustBandView items={ITEMS} progresses={[1, 1, 1]} />);
    const first = screen.getByTestId(`trust-item-${ITEMS[0]!.label}`);
    expect(first.style.opacity).toBe("1");
    expect(first.style.transform).toBe("translateY(0px)");
  });

  it("defaults missing progress entries to 0 rather than throwing", () => {
    render(<TrustBandView items={ITEMS} progresses={[1]} />);
    const last = screen.getByTestId(`trust-item-${ITEMS[2]!.label}`);
    expect(last.style.opacity).toBe("0");
  });
});
