import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Wordmark } from "@webhook-co/ui";

import { geist } from "../fonts";

export interface BrandLockupViewProps {
  /** Spring progress in [0, 1] driving the entrance. A plain number — no Remotion hooks. */
  enter: number;
}

/**
 * Pure presentational half of the adapter. Renders `Wordmark` — unchanged, imported
 * straight from `@webhook-co/ui` — centered on the dark surface, and derives its
 * entrance styles from `enter` via `interpolate()` (a pure function, safe outside a
 * Remotion composition context). No `useCurrentFrame()`/`useVideoConfig()` here, so this
 * component renders exactly like any other React component and is trivially unit-testable
 * in jsdom.
 */
export function BrandLockupView({ enter }: BrandLockupViewProps) {
  const opacity = interpolate(enter, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(enter, [0, 1], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      className="bg-surface items-center justify-center"
      data-theme="dark"
      style={{ fontFamily: geist.fontFamily }}
    >
      <div style={{ opacity, transform: `translateY(${y}px)` }}>
        <Wordmark markSize={40} />
      </div>
    </AbsoluteFill>
  );
}

export interface BrandLockupProps {
  /** Frames to hold before the entrance spring starts. */
  delayFrames?: number;
}

/**
 * Thin Remotion wrapper: owns the motion. Reads `useCurrentFrame()` + `useVideoConfig()`
 * at this boundary only, computes the entrance spring, and hands a plain `enter` number
 * down to `BrandLockupView`. This is the adapter — `Wordmark` itself is reused unchanged.
 */
export function BrandLockup({ delayFrames = 0 }: BrandLockupProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - delayFrames,
    fps,
    config: { damping: 200 },
  });

  return <BrandLockupView enter={enter} />;
}
