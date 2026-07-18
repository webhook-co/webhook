// Packet — the glowing request "packet" that arcs to a target (brief §3.3 /
// §4.7). Used for the anticipation whoosh (S2: POST chip → ingest pill) and the
// replay reply (S11: terminal → localhost chip).
//
// Travels `fromXY` → `toXY` on a quadratic-bezier arc (never a straight line —
// "arcs"), leaves a motion-blur trail tinted `--wire`, and *accelerates*
// (`Easing.in(Easing.cubic)`: slow start, fast arrival — matches the brief's
// "rising whoosh, pitch bends up, cuts at impact").
//
// Land timing is intentionally two-stage, per the brief's S2→S3 beat: the
// packet can *arrive* (finish its arc, `startFrame + durationFrames`) several
// frames before the scene's actual "land" beat (S2 arrives f144; the THOCK is
// f150 — brief calls this out explicitly as "6 frames of near-silence before
// the land"). So:
//   1. traveling  — [startFrame, arrivalFrame)      arc + trail + growing glow
//   2. settled    — [arrivalFrame, landFrame)       a quiet, held glow at the target
//   3. dissolving — [landFrame, landFrame + fade)   fades out, handing the pixel
//                                                     off to the scene's own
//                                                     <RingPulse> + thock beat
// `onLandFrame` lets a scene decouple (2) from (1); if omitted, land === arrival
// and the packet simply disappears the instant it lands. `getPacketLandFrame`
// is exported so the scene can compute the exact same frame for its own
// <RingPulse startFrame={...}> and audio cue — "expose enough to fire the land".
//
// Purely visual, no reveal/state logic to unit-test beyond the land-frame math,
// which is a plain pure function (tested alongside the scene layer). Motion is
// derived entirely from `useCurrentFrame()` — deterministic, no CSS
// transitions/keyframes, no `Math.random`/`Date.now`.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { colors } from "../tokens";

type XY = { x: number; y: number };

type PacketProps = {
  /** Start point (px), in the scene's coordinate space. */
  fromXY: XY;
  /** Target point (px) the packet arcs into. */
  toXY: XY;
  /** Frame the packet begins traveling. */
  startFrame: number;
  /** Travel duration in frames — arrival frame is `startFrame + durationFrames`. */
  durationFrames: number;
  /**
   * Optional override for the scene's "land" beat frame (defaults to the
   * arrival frame). Must be >= arrival frame; use this to hold a quiet settled
   * glow at the target before the scene's own land effects (ring-pulse, event
   * row, thock) take over — see the S2→S3 timing note above.
   */
  onLandFrame?: number;
  /** Head diameter (px) at rest. Defaults to a small request-sized dot. */
  size?: number;
};

/** How long the settled packet takes to dissolve once the land beat fires. */
const LAND_FADE_FRAMES = 6;
/** Number of trailing motion-blur ghosts behind the head. */
const TRAIL_COUNT = 6;
/** Spacing between trail samples, in arc-progress (t) units. */
const TRAIL_STEP = 0.05;

const EASE_IN_CUBIC = Easing.in(Easing.cubic);

/**
 * The frame the scene should treat as the "land" beat — the same frame a scene
 * should pass to its own `<RingPulse startFrame>` and thock `<SfxCue atFrame>`.
 * Clamped so land can never precede the packet's own arrival.
 */
export const getPacketLandFrame = (
  startFrame: number,
  durationFrames: number,
  onLandFrame?: number,
): number => {
  const arrivalFrame = startFrame + durationFrames;
  return Math.max(onLandFrame ?? arrivalFrame, arrivalFrame);
};

/** Point on the quadratic bezier `from` → `control` → `to` at progress `t`. */
const bezierPoint = (from: XY, control: XY, to: XY, t: number): XY => {
  const oneMinusT = 1 - t;
  return {
    x: oneMinusT * oneMinusT * from.x + 2 * oneMinusT * t * control.x + t * t * to.x,
    y: oneMinusT * oneMinusT * from.y + 2 * oneMinusT * t * control.y + t * t * to.y,
  };
};

export const Packet = ({
  fromXY,
  toXY,
  startFrame,
  durationFrames,
  onLandFrame,
  size = 14,
}: PacketProps) => {
  const frame = useCurrentFrame();

  const arrivalFrame = startFrame + durationFrames;
  const landFrame = getPacketLandFrame(startFrame, durationFrames, onLandFrame);
  const dissolvedFrame = landFrame + LAND_FADE_FRAMES;

  if (frame < startFrame || frame >= dissolvedFrame) {
    return null;
  }

  // Arc upward from the midpoint regardless of travel direction — a lobbed,
  // not straight-line, path (brief: "the packet ARCS").
  const dx = toXY.x - fromXY.x;
  const dy = toXY.y - fromXY.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const arcHeight = Math.min(distance * 0.35, 220);
  const control: XY = {
    x: (fromXY.x + toXY.x) / 2,
    y: (fromXY.y + toXY.y) / 2 - arcHeight,
  };

  if (frame < arrivalFrame) {
    // Phase 1 — traveling: accelerating arc with a motion-blur trail.
    const linearT = interpolate(frame, [startFrame, arrivalFrame], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const t = EASE_IN_CUBIC(linearT);
    const head = bezierPoint(fromXY, control, toXY, t);
    const glowBlur = interpolate(t, [0, 1], [8, 22]);

    const trail = Array.from({ length: TRAIL_COUNT }, (_, i) => {
      const k = i + 1;
      const sampleT = Math.max(t - k * TRAIL_STEP, 0);
      const pos = bezierPoint(fromXY, control, toXY, sampleT);
      const falloff = 1 - k / (TRAIL_COUNT + 1);
      return { pos, falloff, key: k };
    });

    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        {trail.map(({ pos, falloff, key }) => (
          <div
            key={key}
            style={{
              position: "absolute",
              left: pos.x,
              top: pos.y,
              width: size * falloff,
              height: size * falloff,
              borderRadius: "50%",
              transform: "translate(-50%, -50%)",
              background: colors.wire,
              opacity: falloff * 0.6,
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            left: head.x,
            top: head.y,
            width: size,
            height: size,
            borderRadius: "50%",
            transform: "translate(-50%, -50%)",
            background: colors.verified,
            boxShadow: `0 0 ${glowBlur}px ${glowBlur * 0.5}px ${colors.verifiedGlow}`,
          }}
        />
      </AbsoluteFill>
    );
  }

  if (frame < landFrame) {
    // Phase 2 — settled: a quiet held glow at the target (the brief's
    // "near-silence" gap between arrival and the scene's land beat).
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            left: toXY.x,
            top: toXY.y,
            width: size,
            height: size,
            borderRadius: "50%",
            transform: "translate(-50%, -50%)",
            background: colors.verified,
            opacity: 0.7,
            boxShadow: `0 0 10px 5px ${colors.verifiedGlow}`,
          }}
        />
      </AbsoluteFill>
    );
  }

  // Phase 3 — dissolving: hands the pixel off to the scene's own land effects.
  const fadeOut = interpolate(frame, [landFrame, dissolvedFrame], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dissolveScale = interpolate(frame, [landFrame, dissolvedFrame], [1, 1.6], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: toXY.x,
          top: toXY.y,
          width: size,
          height: size,
          borderRadius: "50%",
          transform: `translate(-50%, -50%) scale(${dissolveScale})`,
          background: colors.verified,
          opacity: fadeOut * 0.7,
          boxShadow: `0 0 10px 5px ${colors.verifiedGlow}`,
        }}
      />
    </AbsoluteFill>
  );
};
