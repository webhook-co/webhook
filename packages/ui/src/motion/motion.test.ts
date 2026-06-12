import { afterEach, describe, expect, it, vi } from "vitest";

import { duration } from "../tokens/motion";
import {
  exitTransition,
  fadeInUp,
  marketingTransition,
  prefersReducedMotion,
  productTransition,
  stagger,
} from "./index";

describe("transitions", () => {
  it("convert token ms into seconds", () => {
    expect(productTransition.duration).toBeCloseTo(duration.base / 1000);
    expect(marketingTransition.duration).toBeCloseTo(duration.smooth / 1000);
  });

  it("exit is faster than entrance", () => {
    expect(exitTransition.duration).toBeLessThan(productTransition.duration);
  });

  it("fadeInUp keeps product movement small (<= 8px)", () => {
    expect(Math.abs(fadeInUp.initial.y)).toBeLessThanOrEqual(8);
  });
});

describe("stagger", () => {
  it("derives delay and step in seconds", () => {
    const s = stagger(120, 320);
    expect(s.transition.staggerChildren).toBeCloseTo(0.12);
    expect(s.transition.delayChildren).toBeCloseTo(0.32);
  });
});

describe("prefersReducedMotion", () => {
  const original = window.matchMedia;

  afterEach(() => {
    window.matchMedia = original;
  });

  it("returns false when matchMedia is unavailable", () => {
    // @ts-expect-error -- intentionally remove for the no-DOM branch.
    window.matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("reflects a reduce preference", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia;
    expect(prefersReducedMotion()).toBe(true);
  });

  it("reflects no preference", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});
