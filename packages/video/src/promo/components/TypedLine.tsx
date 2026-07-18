// TypedLine — char-by-char terminal typing with a blinking block cursor.
//
// Brief §4.2: `{ text; startFrame; cps?: 30; className?; showCursor? }`. Reveals
// `text` one character at a time via `text.slice(0, Math.floor(frame - startFrame))`
// at 1 char/frame (brief §3.4's literal formula — `cps` defaults to
// `motion.typingCps` = 30, which at the film's fixed 30fps *is* that literal
// formula; passing a different `cps` scales the rate proportionally). The block
// cursor `▉` blinks at 2Hz via `Math.floor(frame/15) % 2`. Every terminal/product
// string in the film renders through this component, so it always sets
// JetBrains Mono (brief §3.2) — never a proportional font.
//
// Split into a pure `TypedLineView` (plain props, no Remotion hooks — renders
// like any other React component in jsdom) and the `TypedLine` wrapper that
// owns `useCurrentFrame()`, mirroring the existing HeadlineScene/BrandLockup
// adapter split in this package.

import type { CSSProperties, ReactElement } from "react";
import { useCurrentFrame } from "remotion";

import { mono } from "../fonts";
import { colors, motion, type } from "../tokens";

export interface TypedLineProps {
  /** The real product/terminal string to type out (rendered byte-for-byte). */
  text: string;
  /** Absolute frame the typing begins on. */
  startFrame: number;
  /** Characters per second. Defaults to `motion.typingCps` (30 — 1 char/frame at 30fps). */
  cps?: number;
  /** Optional class name passed through to the root `<span>`. */
  className?: string;
  /** Whether to render the blinking block cursor. Defaults to `true`. */
  showCursor?: boolean;
}

const CURSOR_GLYPH = "▉";

/**
 * Pure reveal-count function — no Remotion hooks, so it is directly unit
 * testable. At the default `cps` (30) and the film's fixed 30fps, this reduces
 * exactly to brief §3.4's literal `Math.floor(frame - startFrame)`: N frames
 * after `startFrame` reveals exactly N characters. Clamped to `[0, textLength]`
 * so a line never reveals before its start or past its own length.
 */
export function revealedCharCount(
  frame: number,
  startFrame: number,
  textLength: number,
  cps: number = motion.typingCps,
  fps = 30,
): number {
  const elapsedFrames = frame - startFrame;
  if (elapsedFrames <= 0) return 0;
  const count = Math.floor((elapsedFrames * cps) / fps);
  return Math.min(textLength, count);
}

/**
 * Block-cursor blink phase — brief §3.4's exact `Math.floor(frame/15) % 2`
 * formula (2Hz at 30fps). `true` means "on" (visible) this frame.
 */
export function isCursorOn(frame: number): boolean {
  return Math.floor(frame / motion.cursorBlinkFrames) % 2 === 0;
}

export interface TypedLineViewProps {
  /** Already-sliced substring of `text` to render this frame. */
  visibleText: string;
  /** Current blink phase from `isCursorOn`. Ignored when `showCursor` is `false`. */
  cursorOn: boolean;
  showCursor: boolean;
  className?: string;
}

/**
 * Pure presentational half: takes the already-computed reveal + cursor phase
 * as plain props (no `useCurrentFrame()`), so it renders exactly like any
 * other React component and is trivially unit-testable in jsdom.
 */
export function TypedLineView({
  visibleText,
  cursorOn,
  showCursor,
  className,
}: TypedLineViewProps): ReactElement {
  const style: CSSProperties = {
    ...type.terminalBody,
    fontFamily: mono,
    color: colors.termFg,
    whiteSpace: "pre",
  };

  return (
    <span className={className} style={style}>
      {visibleText}
      {showCursor ? (
        <span aria-hidden style={{ opacity: cursorOn ? 1 : 0 }}>
          {CURSOR_GLYPH}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`, computes the reveal count
 * and cursor phase, and hands plain values down to `TypedLineView`.
 */
export function TypedLine({
  text,
  startFrame,
  cps = motion.typingCps,
  className,
  showCursor = true,
}: TypedLineProps): ReactElement {
  const frame = useCurrentFrame();
  const revealed = revealedCharCount(frame, startFrame, text.length, cps);
  const visibleText = text.slice(0, revealed);
  const cursorOn = isCursorOn(frame);

  return (
    <TypedLineView
      visibleText={visibleText}
      cursorOn={cursorOn}
      showCursor={showCursor}
      className={className}
    />
  );
}
