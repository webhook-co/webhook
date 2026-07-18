// RingPulse — the "land" radiate effect (brief §3.3 / §3.4 / §4.8).
//
// An expanding circular stroke in `--wire` that radiates outward from a point as
// an event "lands": scale 0.6→2.4, opacity 0.5→0, over 24 frames,
// `Easing.out(Easing.cubic)` — the exact §3.4 spec. Fires on every land beat
// (S3 first land, S11 replay echo, S16 the wake, S19 close ring).
//
// Purely visual, no reveal/state logic to unit-test: motion is derived entirely
// from `useCurrentFrame()` — deterministic, no CSS transitions/keyframes, no
// `Math.random`/`Date.now`.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { colors, motion } from "../tokens";

type RingPulseProps = {
  /** Center point (px), in the scene's coordinate space, the ring radiates from. */
  atXY: { x: number; y: number };
  /** Frame the pulse begins radiating. */
  startFrame: number;
  /** Ring diameter (px) at scale 1.0. Defaults to an event-row-sized ring. */
  size?: number;
};

const EASE_OUT_CUBIC = Easing.out(Easing.cubic);

export const RingPulse = ({ atXY, startFrame, size = 120 }: RingPulseProps) => {
  const frame = useCurrentFrame();
  const { scaleFrom, scaleTo, opacityFrom, opacityTo, durationFrames } = motion.ringPulse;
  const endFrame = startFrame + durationFrames;

  if (frame < startFrame || frame > endFrame) {
    return null;
  }

  const scale = interpolate(frame, [startFrame, endFrame], [scaleFrom, scaleTo], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [startFrame, endFrame], [opacityFrom, opacityTo], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: atXY.x,
          top: atXY.y,
          width: size,
          height: size,
          borderRadius: "50%",
          border: `2px solid ${colors.wire}`,
          transform: `translate(-50%, -50%) scale(${scale})`,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};
