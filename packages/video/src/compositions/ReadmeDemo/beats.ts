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

/** The composition canvas. Root.tsx and the window-centring math share these. */
export const READMEDEMO_WIDTH = 1280;
export const READMEDEMO_HEIGHT = 720;

/** The terminal viewport's intrinsic size — the recording's native pixels. */
export const TERMINAL_WIDTH = 1060;
export const TERMINAL_HEIGHT = 430;

/** The window title bar's height — shared by the chrome view and the caption offset. */
export const CHROME_HEIGHT = 44;

export interface Caption {
  readonly from: number;
  readonly durationInFrames: number;
  readonly text: string;
}

/**
 * The second beat, named so the callout can derive its window from it (they
 * must arrive together — see CALLOUT).
 */
const VERDICT_CAPTION: Caption = {
  from: 150,
  durationInFrames: 150,
  text: "with its signature checked — 141 providers built in",
};

/**
 * Two beats, no more. A README GIF is read in a glance, and the reader is
 * already on the page — a title card would spend the loop's best seconds
 * saying what the heading above it already says.
 */
export const CAPTIONS: readonly Caption[] = [
  { from: 30, durationInFrames: 110, text: "every webhook that arrives, live" },
  VERDICT_CAPTION,
] as const;

export const CAPTION_FADE_FRAMES = 10;

/**
 * A trapezoid opacity envelope over [from, from+duration]: 0 at the ends, 1
 * across the middle, ramping over `fade` frames on each side. Clamped, so any
 * frame in the composition is safe to pass. Both the captions and the callout
 * are the same shape — this is their one definition.
 */
function envelope(frame: number, from: number, duration: number, fade: number): number {
  const end = from + duration;
  return interpolate(frame, [from, from + fade, end - fade, end], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function captionOpacity(frame: number, caption: Caption): number {
  return envelope(frame, caption.from, caption.durationInFrames, CAPTION_FADE_FRAMES);
}

/**
 * When the verdict callout is up. DERIVED from the second caption, not a matching
 * literal: the band and the words that explain it must arrive together, or the
 * highlight reads as a rendering artifact — so the coupling is by construction.
 */
export const CALLOUT = {
  from: VERDICT_CAPTION.from,
  durationInFrames: VERDICT_CAPTION.durationInFrames,
} as const;

const CALLOUT_FADE_FRAMES = 12;

export function calloutOpacity(frame: number): number {
  return envelope(frame, CALLOUT.from, CALLOUT.durationInFrames, CALLOUT_FADE_FRAMES);
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
