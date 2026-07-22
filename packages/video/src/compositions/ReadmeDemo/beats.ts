// beats.ts — the README demo's timing + geometry, as pure functions.
//
// This composition overlays a REAL `wbhk listen` recording (public/terminal.mp4,
// 300 frames @ 25fps). Everything here is deterministic and hook-free so the
// schedule can be unit-tested without a Remotion composition context — the same
// View/wrapper split the promo film uses throughout.
//
// The footage is the proof; the overlay only points at it. Nothing here may
// assert anything the recording doesn't actually show.

import { interpolate } from "remotion";

/** Must match public/terminal.mp4 exactly, or the overlay drifts off the rows. */
export const READMEDEMO_FPS = 25;
export const READMEDEMO_DURATION_IN_FRAMES = 300;

/** The terminal viewport's intrinsic size — the recording's native pixels. */
export const TERMINAL_WIDTH = 1060;
export const TERMINAL_HEIGHT = 430;

export interface Caption {
  readonly from: number;
  readonly durationInFrames: number;
  readonly text: string;
}

/**
 * Two beats, no more. A README GIF is read in a glance, and the reader is
 * already on the page — a title card would spend the loop's best seconds
 * saying what the heading above it already says.
 */
export const CAPTIONS: readonly Caption[] = [
  { from: 30, durationInFrames: 110, text: "every webhook that arrives, live" },
  {
    from: 150,
    durationInFrames: 150,
    text: "with its signature checked — 141 providers built in",
  },
] as const;

export const CAPTION_FADE_FRAMES = 10;

/**
 * Cross-fade envelope for one caption: 0 at its first and last frame, 1 across
 * the middle. Clamped, so callers can pass any frame in the composition.
 */
export function captionOpacity(
  frame: number,
  caption: Caption,
  fade: number = CAPTION_FADE_FRAMES,
): number {
  const end = caption.from + caption.durationInFrames;
  return interpolate(frame, [caption.from, caption.from + fade, end - fade, end], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * When the verdict callout is up. Deliberately tied to the second caption: the
 * band and the words that explain it must arrive together, or the highlight
 * reads as a rendering artifact.
 */
export const CALLOUT = { from: 150, durationInFrames: 150 } as const;

const CALLOUT_FADE_FRAMES = 12;

export function calloutOpacity(frame: number): number {
  const end = CALLOUT.from + CALLOUT.durationInFrames;
  return interpolate(
    frame,
    [CALLOUT.from, CALLOUT.from + CALLOUT_FADE_FRAMES, end - CALLOUT_FADE_FRAMES, end],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
}

/**
 * The highlight band over the signature-verdict column, in the recording's own
 * coordinate space (origin = terminal viewport top-left).
 *
 * Measured off the real frames, not guessed: amber `unverified` ink spans
 * x 243..381, green `verified` ink spans x 315..425. The TUI separates columns
 * with spaces rather than padding to a fixed width, so the two verdicts do NOT
 * share a left edge — the band covers the union of both, with breathing room.
 */
export const VERDICT_BAND = { x: 232, y: 66, width: 206, height: 238 } as const;
