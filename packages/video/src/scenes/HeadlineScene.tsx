import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { geist } from "../fonts";

export interface HeadlineSceneViewProps {
  headline: string;
  tagline: string;
  /** Spring progress in [0, 1] driving the entrance. A plain number — no Remotion hooks. */
  enter: number;
}

/**
 * Pure presentational half of the adapter (same split as `BrandLockupView`): renders the
 * headline (large, `text-fg`) and tagline (smaller, muted via `text-fg-muted`) using the
 * design-system's rem-based type scale, and derives its entrance styles from `enter` via
 * `interpolate()` — a pure function, safe outside a Remotion composition context. No
 * `useCurrentFrame()`/`useVideoConfig()` here, so this component renders exactly like any
 * other React component and is trivially unit-testable in jsdom.
 */
export function HeadlineSceneView({ headline, tagline, enter }: HeadlineSceneViewProps) {
  const opacity = interpolate(enter, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(enter, [0, 1], [24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      className="items-center justify-center px-16 text-center"
      style={{ fontFamily: geist.fontFamily }}
    >
      <div style={{ opacity, transform: `translateY(${y}px)` }}>
        <h1 className="text-5xl font-semibold tracking-heading text-fg">{headline}</h1>
        <p className="mt-6 text-lg text-fg-muted">{tagline}</p>
      </div>
    </AbsoluteFill>
  );
}

export interface HeadlineSceneProps {
  headline: string;
  tagline: string;
  /** Frames to hold before the entrance spring starts. */
  delayFrames?: number;
}

/**
 * Thin Remotion wrapper: owns the motion, mirroring `BrandLockup`. Reads
 * `useCurrentFrame()` + `useVideoConfig()` at this boundary only, computes the entrance
 * spring, and hands a plain `enter` number down to `HeadlineSceneView`.
 */
export function HeadlineScene({ headline, tagline, delayFrames = 0 }: HeadlineSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - delayFrames,
    fps,
    config: { damping: 200 },
  });

  return <HeadlineSceneView headline={headline} tagline={tagline} enter={enter} />;
}
