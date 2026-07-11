import { describe, expect, it } from "vitest";

import { ink } from "./ink";
import { dark, light } from "./semantic";
import { duration, easing } from "./motion";
import { fontSize, fontWeight } from "./typography";

const HEX = /^#[0-9a-f]{6}$/;
const REM = /^(\d+(\.\d+)?)rem$/;

/** The root font-size every rem token is authored against (the browser default). */
const ROOT_PX = 16;

const rem = (token: string): number => {
  const match = REM.exec(token);
  if (!match) throw new Error(`expected a rem value, got ${token}`);
  return Number(match[1]) * ROOT_PX;
};

describe("ink scale", () => {
  it("has 14 stops from white to void", () => {
    expect(Object.keys(ink)).toHaveLength(14);
    expect(ink[0]).toBe("#ffffff");
    expect(ink[1000]).toBe("#0b0f14");
  });

  it("is all valid 6-digit hex", () => {
    for (const value of Object.values(ink)) {
      expect(value).toMatch(HEX);
    }
  });
});

describe("semantic themes", () => {
  it("define the same shape for light and dark", () => {
    expect(Object.keys(light.surface)).toEqual(Object.keys(dark.surface));
    expect(Object.keys(light.state)).toEqual(Object.keys(dark.state));
    expect(light.chart).toHaveLength(5);
    expect(dark.chart).toHaveLength(5);
  });

  it("expose exactly four functional states", () => {
    expect(Object.keys(light.state).sort()).toEqual(["danger", "info", "ok", "warn"]);
  });
});

describe("typography", () => {
  it("uses 620 as the brand semibold", () => {
    expect(fontWeight.semibold).toBe("620");
  });

  // The scale is root-relative so the platform honors the reader's browser font-size preference.
  // An absolute px value here silently opts the whole platform out of that preference — every app's
  // body type flows from these tokens, so this assertion is the only thing standing between a
  // convenient "just use px" edit and an accessibility regression across three apps.
  it("authors every size in rem, never px", () => {
    for (const [step, value] of Object.entries(fontSize)) {
      expect(value, `fontSize.${step} must be rem, not an absolute unit`).toMatch(REM);
    }
  });

  // Pin the rendered pixel size of each step at the default 16px root. Nothing pinned these before,
  // so a token edit could move every surface on the platform with a green build.
  it("pins the scale at a 16px root", () => {
    expect(Object.fromEntries(Object.entries(fontSize).map(([k, v]) => [k, rem(v)]))).toEqual({
      xs: 12,
      sm: 14,
      base: 15,
      md: 16,
      lg: 18,
      xl: 22,
      "2xl": 28,
      "3xl": 36,
      "4xl": 48,
      "5xl": 64,
    });
  });

  it("ascends monotonically", () => {
    const sizes = Object.values(fontSize).map(rem);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  // `base` is the product-UI default; `md` is the long-form reading size that marketing and legal
  // prose opt into. If they ever collapse to one value the distinction is dead and callers will
  // start using them interchangeably.
  it("keeps the reading size (md) a real step above the product-UI default (base)", () => {
    expect(rem(fontSize.md)).toBeGreaterThan(rem(fontSize.base));
  });
});

describe("motion tokens", () => {
  it("orders durations from instant to slow", () => {
    const values = Object.values(duration);
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });

  it("expresses easings as four-point cubic-bezier control tuples", () => {
    for (const points of Object.values(easing)) {
      expect(points).toHaveLength(4);
    }
  });
});
