// DeliveryFlow — the delivery motif for S10: FIFO queue, retry, dead-letter
// (brief §5 S10 / §3.3).
//
// A minimal graphical strip: small event chips depart a left-side queue on a
// steady beat and travel a track into an endpoint node. One chip (the "retry"
// chip) fails just short of the endpoint, bounces back, holds, and re-advances
// to land on its retry — it stays visible the whole time, it never disappears.
// A second chip (the "dead-letter" chip) diverts off the track partway and is
// caught by a small bin, which blinks once on the catch — held, not silently
// dropped.
//
// Purely graphical: this component renders NO text. The scene overlays its own
// labels ("FIFO per endpoint", "retries", "dead-letter") using the exported
// `*_X_FRACTION` / `*_Y_FRACTION` constants below to align them with the
// geometry (of whatever `width`/`height` box the scene requests).
//
// Accent discipline (brief §3.1 / repo rules): this scene is NOT one of the two
// sanctioned non-green moments (S7's mutation, S9's legend), so nothing here
// ever renders `colors.failed`. "Failure" reads entirely through MOTION (the
// bounce-back, the divert) — chips stay neutral (`termBorder` / `termBg2` /
// `termDim`) and only ever flash the film's one accent, `colors.verified`, on a
// successful land (reusing `VerifiedBadge`'s own pop + glow helpers, exactly
// like `EventRow` does), or a soft `colors.wire` pulse on the dead-letter bin's
// catch.
//
// All motion is a pure function of `useCurrentFrame()` — no Math.random,
// Date.now, or CSS transitions/keyframes. The beat/phase/progress math below
// takes no Remotion hooks (mirrors `Packet`'s `getPacketLandFrame` /
// `VerifiedBadge`'s `badgePopScale` split) so it is unit-tested directly in
// `DeliveryFlow.test.ts`.

import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { colors, motion } from "../tokens";
import { badgeGlowOpacity, badgePopScale } from "./VerifiedBadge";

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);
const EASE_OUT_CUBIC = Easing.out(Easing.cubic);

/** Number of event chips in the queue. */
export const CHIP_COUNT = 5;
/** Frames between successive chips departing the queue onto the track — the steady beat. */
export const BEAT_FRAMES = 12;
/** Frames a normal chip takes to travel queue -> endpoint. */
export const TRAVEL_FRAMES = 10;

/** Index of the chip that fails just short of the endpoint and retries. */
export const RETRY_CHIP_INDEX = 2;
/** Track progress (0 = queue, 1 = endpoint) the retry chip reaches before failing. */
export const FAIL_STOP_PROGRESS = 0.82;
/** Track progress the retry chip bounces back to before re-advancing. */
export const RETREAT_PROGRESS = 0.5;
/** Frames spent bouncing back from FAIL_STOP_PROGRESS to RETREAT_PROGRESS. */
export const RETREAT_FRAMES = 8;
/** Frames held at RETREAT_PROGRESS before re-advancing (the "held, not dropped" beat). */
export const RETRY_PAUSE_FRAMES = 6;
/** Frames spent re-advancing from RETREAT_PROGRESS to the endpoint (1) on the retry. */
export const RETRY_ADVANCE_FRAMES = 12;
/** Total frames after the retry chip's own departure until it lands for good. */
export const RETRY_LAND_OFFSET =
  TRAVEL_FRAMES + RETREAT_FRAMES + RETRY_PAUSE_FRAMES + RETRY_ADVANCE_FRAMES;

/** Index of the chip a small dead-letter bin catches instead of the endpoint. */
export const DEAD_LETTER_CHIP_INDEX = 4;
/** Track progress the dead-letter chip diverts off the track at (it never reaches 1). */
export const DIVERT_PROGRESS = 0.58;
/** Frames spent traveling queue -> the divert point. */
export const DIVERT_TRAVEL_FRAMES = 9;
/** Frames spent dropping from the track into the bin once diverted. */
export const CATCH_FRAMES = 10;

/** Fractional geometry (of the component's own `width`/`height`) so a scene can align its
 * own text labels ("FIFO per endpoint", "retries", "dead-letter") with the drawn motif. */
export const QUEUE_X_FRACTION = 0.08;
export const ENDPOINT_X_FRACTION = 0.9;
export const TRACK_Y_FRACTION = 0.55;
export const DEAD_LETTER_Y_FRACTION = 0.86;
/** x-fraction the dead-letter bin sits at (derived: the track position it diverts from). */
export const DEAD_LETTER_X_FRACTION =
  QUEUE_X_FRACTION + (ENDPOINT_X_FRACTION - QUEUE_X_FRACTION) * DIVERT_PROGRESS;
/** x-fraction roughly midway through the retry chip's fail/retreat zone. */
export const RETRY_ZONE_X_FRACTION =
  QUEUE_X_FRACTION +
  (ENDPOINT_X_FRACTION - QUEUE_X_FRACTION) * ((FAIL_STOP_PROGRESS + RETREAT_PROGRESS) / 2);

/** Absolute (scene-local) frame the chip at `index` departs the queue onto the track. */
export function chipDepartFrame(
  index: number,
  startFrame: number,
  beatFrames: number = BEAT_FRAMES,
): number {
  return startFrame + index * beatFrames;
}

/** A normal chip's track progress (0 = queue, 1 = endpoint), eased, clamped both ends. */
export function normalChipProgress(
  relativeFrame: number,
  travelFrames: number = TRAVEL_FRAMES,
): number {
  return interpolate(relativeFrame, [0, travelFrames], [0, 1], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export type RetryPhase = "queued" | "advancing" | "retreating" | "paused" | "retrying" | "landed";

/** The retry chip's discrete phase at a frame relative to its own departure. */
export function retryChipPhase(relativeFrame: number): RetryPhase {
  if (relativeFrame < 0) return "queued";
  if (relativeFrame < TRAVEL_FRAMES) return "advancing";
  if (relativeFrame < TRAVEL_FRAMES + RETREAT_FRAMES) return "retreating";
  if (relativeFrame < TRAVEL_FRAMES + RETREAT_FRAMES + RETRY_PAUSE_FRAMES) return "paused";
  if (relativeFrame < RETRY_LAND_OFFSET) return "retrying";
  return "landed";
}

/**
 * The retry chip's track progress through all five phases: advance, fail-and-retreat, hold,
 * re-advance, land. It bounces back — it never returns to (or below) 0, and it is never
 * hidden by this function; visibility is the caller's concern (it stays fully opaque
 * throughout every one of these phases — see `DeliveryFlow`'s render).
 */
export function retryChipProgress(relativeFrame: number): number {
  const phase = retryChipPhase(relativeFrame);
  switch (phase) {
    case "queued":
      return 0;
    case "advancing":
      return interpolate(relativeFrame, [0, TRAVEL_FRAMES], [0, FAIL_STOP_PROGRESS], {
        easing: EASE_INOUT_CUBIC,
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    case "retreating":
      return interpolate(
        relativeFrame,
        [TRAVEL_FRAMES, TRAVEL_FRAMES + RETREAT_FRAMES],
        [FAIL_STOP_PROGRESS, RETREAT_PROGRESS],
        { easing: EASE_INOUT_CUBIC, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
    case "paused":
      return RETREAT_PROGRESS;
    case "retrying":
      return interpolate(
        relativeFrame,
        [RETRY_LAND_OFFSET - RETRY_ADVANCE_FRAMES, RETRY_LAND_OFFSET],
        [RETREAT_PROGRESS, 1],
        { easing: EASE_INOUT_CUBIC, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
    case "landed":
      return 1;
  }
}

/**
 * The dead-letter chip's position: `along` the track (0 = queue, capped at
 * `DIVERT_PROGRESS` — it never reaches the endpoint's progress of 1) and `caught`
 * (0 = still on the track, 1 = fully settled in the bin).
 */
export function deadLetterChipProgress(relativeFrame: number): { along: number; caught: number } {
  const along = interpolate(relativeFrame, [0, DIVERT_TRAVEL_FRAMES], [0, DIVERT_PROGRESS], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const caught = interpolate(
    relativeFrame,
    [DIVERT_TRAVEL_FRAMES, DIVERT_TRAVEL_FRAMES + CATCH_FRAMES],
    [0, 1],
    { easing: EASE_OUT_CUBIC, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return { along, caught };
}

/** The frame the dead-letter chip is fully settled in the bin — the "catch" beat a scene
 * (or this component's own bin blink) should treat as the moment it fires. */
export function deadLetterCatchFrame(departFrame: number): number {
  return departFrame + DIVERT_TRAVEL_FRAMES + CATCH_FRAMES;
}

/**
 * The bin's "blinks once" pulse: 0 before the catch, 1 at the catch, decaying to 0 over the
 * film's ring-pulse duration (brief §3.4's `motion.ringPulse.durationFrames`) — reused here
 * for visual consistency with every other "land" decay in the film, but tinted `colors.wire`
 * (never `colors.failed`) so the bin reads as a single confirming flash, not an alarm.
 */
export function binBlinkOpacity(frame: number, catchFrame: number): number {
  if (frame < catchFrame) return 0;
  return interpolate(frame, [catchFrame, catchFrame + motion.ringPulse.durationFrames], [1, 0], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 220;
const CHIP_W = 30;
const CHIP_H = 14;
const ENDPOINT_SIZE = 26;
const BIN_W = 40;
const BIN_H = 24;
const STACK_GAP = 24;
/** Track progress a departed chip takes to visually merge from its queue stack offset onto
 * the shared track height — quick, so the queue reads as "peeling into single file". */
const MERGE_PROGRESS = 0.15;

export interface DeliveryFlowProps {
  /** Scene-local frame chip 0 departs the queue; the rest follow on `BEAT_FRAMES`. */
  startFrame: number;
  /** Drawing box width in px. Defaults to a strip that fits a terminal island body. */
  width?: number;
  /** Drawing box height in px. */
  height?: number;
}

export function DeliveryFlow({
  startFrame,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: DeliveryFlowProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const queueX = width * QUEUE_X_FRACTION;
  const endpointX = width * ENDPOINT_X_FRACTION;
  const trackY = height * TRACK_Y_FRACTION;
  const trackSpan = endpointX - queueX;
  const binX = width * DEAD_LETTER_X_FRACTION;
  const binY = height * DEAD_LETTER_Y_FRACTION;

  const departDeadLetter = chipDepartFrame(DEAD_LETTER_CHIP_INDEX, startFrame);
  const catchFrame = deadLetterCatchFrame(departDeadLetter);
  const blink = binBlinkOpacity(frame, catchFrame);

  return (
    <div style={{ position: "relative", width, height }}>
      {/* Track — the ordered path every chip departs the queue onto. */}
      <div
        style={{
          position: "absolute",
          left: queueX,
          top: trackY,
          width: trackSpan,
          height: 1,
          background: colors.termBorder,
        }}
      />

      {/* Endpoint node. */}
      <div
        style={{
          position: "absolute",
          left: endpointX,
          top: trackY,
          width: ENDPOINT_SIZE,
          height: ENDPOINT_SIZE,
          borderRadius: 8,
          border: `1.5px solid ${colors.wire}`,
          background: colors.termBg2,
          transform: "translate(-50%, -50%)",
        }}
      />

      {/* Dead-letter bin — blinks once on the catch (colors.wire, never colors.failed). */}
      <div
        style={{
          position: "absolute",
          left: binX,
          top: binY,
          width: BIN_W,
          height: BIN_H,
          borderRadius: 6,
          border: `1.5px solid ${colors.termBorder}`,
          background: colors.termBg2,
          transform: "translate(-50%, -50%)",
          boxShadow: blink > 0 ? `0 0 ${Math.round(20 * blink)}px ${colors.wire}` : "none",
        }}
      />

      {Array.from({ length: CHIP_COUNT }, (_, index) => {
        const departFrame = chipDepartFrame(index, startFrame);
        const relativeFrame = frame - departFrame;
        const stackOffsetY = (index - (CHIP_COUNT - 1) / 2) * STACK_GAP;

        let along: number;
        let y: number;
        let opacity = 1;
        // Non-null only for chips that land at the endpoint (normal + retry) — drives the
        // shared VerifiedBadge pop+glow ("delivered") and the post-land absorb fade.
        let arrivalFrame: number | null = null;

        if (index === DEAD_LETTER_CHIP_INDEX) {
          const { along: a, caught } = deadLetterChipProgress(relativeFrame);
          along = a;
          const mergeY = interpolate(along, [0, MERGE_PROGRESS], [stackOffsetY, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          y = interpolate(caught, [0, 1], [trackY + mergeY, binY], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          // Held in the bin, dimmed but still visible — caught, not vanished.
          opacity = interpolate(caught, [0, 1], [1, 0.6], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
        } else {
          along =
            index === RETRY_CHIP_INDEX
              ? retryChipProgress(relativeFrame)
              : normalChipProgress(relativeFrame);
          const mergeY = interpolate(along, [0, MERGE_PROGRESS], [stackOffsetY, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          y = trackY + mergeY;
          arrivalFrame =
            departFrame + (index === RETRY_CHIP_INDEX ? RETRY_LAND_OFFSET : TRAVEL_FRAMES);
          if (frame >= arrivalFrame) {
            // Delivered — absorbed into the endpoint over the ring-pulse decay window.
            opacity = interpolate(
              frame,
              [arrivalFrame, arrivalFrame + motion.ringPulse.durationFrames],
              [1, 0],
              { easing: EASE_OUT_CUBIC, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            );
          }
        }

        const x = queueX + trackSpan * along;
        const landRelative = arrivalFrame !== null ? frame - arrivalFrame : -1;
        const scale = landRelative >= 0 ? badgePopScale(landRelative, fps) : 1;
        const glow = landRelative >= 0 ? badgeGlowOpacity(landRelative) : 0;
        const dotColor = glow > 0 ? colors.verified : colors.termDim;

        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: CHIP_W,
              height: CHIP_H,
              borderRadius: CHIP_H / 2,
              border: `1px solid ${colors.termBorder}`,
              background: colors.termBg2,
              opacity,
              transform: `translate(-50%, -50%) scale(${scale})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: dotColor,
                boxShadow:
                  glow > 0 ? `0 0 ${Math.round(10 * glow)}px ${colors.verifiedGlow}` : "none",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
