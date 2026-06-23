import { describe, expect, it } from "vitest";

import { decodeKey } from "./keys.js";

const ESC = "\x1b";

describe("decodeKey", () => {
  it("maps the CSI arrow sequences to up/down", () => {
    expect(decodeKey(`${ESC}[A`)).toBe("up");
    expect(decodeKey(`${ESC}[B`)).toBe("down");
  });

  it("maps the SS3 (application-cursor) arrow variants to up/down", () => {
    expect(decodeKey(`${ESC}OA`)).toBe("up");
    expect(decodeKey(`${ESC}OB`)).toBe("down");
  });

  it("maps vim j/k to down/up", () => {
    expect(decodeKey("k")).toBe("up");
    expect(decodeKey("j")).toBe("down");
  });

  it("maps the action keys d/r/o", () => {
    expect(decodeKey("d")).toBe("detail");
    expect(decodeKey("r")).toBe("replay");
    expect(decodeKey("o")).toBe("open");
  });

  it("treats q, Ctrl-C, and a bare ESC as quit", () => {
    expect(decodeKey("q")).toBe("quit");
    expect(decodeKey("\x03")).toBe("quit");
    expect(decodeKey(ESC)).toBe("quit");
  });

  it("returns none for unbound input (other letters, digits, empty)", () => {
    expect(decodeKey("x")).toBe("none");
    expect(decodeKey("1")).toBe("none");
    expect(decodeKey("")).toBe("none");
    expect(decodeKey(`${ESC}[C`)).toBe("none"); // right-arrow — unbound
  });
});
