import { describe, expect, it } from "vitest";

import { ink } from "./ink";
import { dark, light } from "./semantic";
import { duration, easing } from "./motion";
import { fontWeight } from "./typography";

const HEX = /^#[0-9a-f]{6}$/;

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
