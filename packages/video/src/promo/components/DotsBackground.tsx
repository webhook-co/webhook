// DotsBackground — the film's faint drifting dot-grid (brief §3.3 / §4.15).
//
// A full-frame background motif for hero/page scenes: a faint dot lattice on the
// base surface, drifting 2px over 300 frames. Dot ink is term-dim at ~8% alpha
// on dark and page-dim at ~6% alpha on light. All motion is derived from
// useCurrentFrame() — deterministic, no CSS transitions/keyframes, no clock.

import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { colors } from "../tokens";

type DotsBackgroundProps = {
  theme: "dark" | "light";
};

// Lattice spacing in px. A subtle 2px drift against a 32px grid reads as a slow,
// living surface without ever tiling visibly.
const DOT_SPACING = 32;

// Ping-pong the drift: 2px out over 300 frames, 2px back over the next 300, so
// the loop seam is a smooth reversal rather than a hard jump back to 0.
const DRIFT_PERIOD = 600;

export const DotsBackground = ({ theme }: DotsBackgroundProps) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame % DRIFT_PERIOD, [0, 300, DRIFT_PERIOD], [0, 2, 0]);

  const dark = theme === "dark";
  // term-dim #6E7681 → rgb(110,118,129) at 8% (dark);
  // page-dim #5B6069 → rgb(91,96,105) at 6% (light).
  const dot = dark ? "rgba(110, 118, 129, 0.08)" : "rgba(91, 96, 105, 0.06)";
  const base = dark ? colors.termBg : colors.pageBg;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: base,
        backgroundImage: `radial-gradient(circle at center, ${dot} 0 1.2px, transparent 1.4px)`,
        backgroundSize: `${DOT_SPACING}px ${DOT_SPACING}px`,
        backgroundPosition: `${drift}px ${drift}px`,
      }}
    />
  );
};
