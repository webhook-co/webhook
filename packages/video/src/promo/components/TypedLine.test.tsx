import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isCursorOn, revealedCharCount, TypedLineView } from "./TypedLine";

// The reveal/cursor math is the real logic in TypedLine (brief §3.4's exact
// `text.slice(0, Math.floor(frame - startFrame))` + `Math.floor(frame/15) % 2`
// formulas) — test it directly as pure functions, then confirm the pure View
// renders whatever it's handed (mirrors the HeadlineScene/BrandLockup split).
describe("revealedCharCount", () => {
  it("reveals zero characters before startFrame", () => {
    expect(revealedCharCount(0, 20, 16)).toBe(0);
    expect(revealedCharCount(19, 20, 16)).toBe(0);
  });

  it("reveals exactly N characters at frame startFrame + N (default cps=30 @ 30fps)", () => {
    const startFrame = 214;
    const textLength = "linear  verified".length;
    for (let n = 0; n <= textLength; n++) {
      expect(revealedCharCount(startFrame + n, startFrame, textLength)).toBe(n);
    }
  });

  it("never reveals past the text length once typing has finished", () => {
    const startFrame = 100;
    const textLength = 10;
    expect(revealedCharCount(startFrame + 50, startFrame, textLength)).toBe(textLength);
  });

  it("scales the reveal rate proportionally for a non-default cps", () => {
    // 15 cps at 30fps == 1 char every 2 frames.
    expect(revealedCharCount(110, 100, 20, 15)).toBe(5);
  });
});

describe("isCursorOn", () => {
  it("toggles every 15 frames (2Hz at 30fps) per Math.floor(frame/15) % 2", () => {
    expect(isCursorOn(0)).toBe(true);
    expect(isCursorOn(14)).toBe(true);
    expect(isCursorOn(15)).toBe(false);
    expect(isCursorOn(29)).toBe(false);
    expect(isCursorOn(30)).toBe(true);
  });
});

describe("TypedLineView", () => {
  it("renders exactly the visible substring it's handed", () => {
    const { getByText } = render(
      <TypedLineView visibleText="linear" cursorOn={true} showCursor={true} />,
    );
    expect(getByText("linear", { exact: false })).toBeTruthy();
  });

  it("hides the cursor glyph (opacity 0) when the blink phase is off", () => {
    const { container } = render(
      <TypedLineView visibleText="linear" cursorOn={false} showCursor={true} />,
    );
    const cursor = container.querySelector("span[aria-hidden]") as HTMLElement | null;
    expect(cursor).not.toBeNull();
    expect(cursor?.style.opacity).toBe("0");
  });

  it("shows the cursor glyph (opacity 1) when the blink phase is on", () => {
    const { container } = render(
      <TypedLineView visibleText="linear" cursorOn={true} showCursor={true} />,
    );
    const cursor = container.querySelector("span[aria-hidden]") as HTMLElement | null;
    expect(cursor?.style.opacity).toBe("1");
  });

  it("renders no cursor element at all when showCursor is false", () => {
    const { container } = render(
      <TypedLineView visibleText="linear" cursorOn={true} showCursor={false} />,
    );
    expect(container.querySelector("span[aria-hidden]")).toBeNull();
  });
});
