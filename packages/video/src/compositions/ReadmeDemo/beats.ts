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
 * Two beats, no more. A README GIF is read in a glance, and the reader is
 * already on the page — a title card would spend the loop's best seconds
 * saying what the heading above it already says. The second beat names what the
 * terminal's own colouring is already showing (the `verified`/`unverified`
 * column), so no on-screen overlay is needed to point at it.
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
