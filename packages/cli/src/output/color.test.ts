import { describe, expect, it } from "vitest";

import { colorize, stripAnsi } from "./color.js";

const ESC = String.fromCharCode(27);

describe("colorize", () => {
  it("wraps text in an SGR sequence when enabled", () => {
    const out = colorize("active", "green", true);
    expect(out).toBe(`${ESC}[32mactive${ESC}[0m`);
    expect(stripAnsi(out)).toBe("active");
  });

  it("returns text untouched when disabled (no escapes)", () => {
    const out = colorize("paused", "yellow", false);
    expect(out).toBe("paused");
    expect(out).not.toContain(ESC);
  });
});

describe("stripAnsi", () => {
  it("removes color escapes and leaves plain text intact", () => {
    expect(stripAnsi(`${ESC}[31mBROKEN${ESC}[0m`)).toBe("BROKEN");
    expect(stripAnsi("plain")).toBe("plain");
  });
});
