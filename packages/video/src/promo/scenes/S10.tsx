// S10 · frames 720–810 · 0:24–0:27 — delivery: never silently dropped (brief §5 S10).
//
// Back to the dark terminal. A <DeliveryFlow> plays the FIFO-queue / retry /
// dead-letter motif inside a terminal island; chips depart from local f4 (comp
// f724). Small dim labels ("FIFO per endpoint" · "retries" · "dead-letter") pin
// to the motif's geometry via DeliveryFlow's exported *_FRACTION alignment
// constants. The kinetic line "Received once, in order, never silently dropped."
// settles beneath. All "failure" reads through motion, never color (brief §3.1):
// the scene stays green-only. Authored in scene-local frames.

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import {
  DEAD_LETTER_X_FRACTION,
  DEAD_LETTER_Y_FRACTION,
  DeliveryFlow,
  QUEUE_X_FRACTION,
  RETRY_ZONE_X_FRACTION,
  TRACK_Y_FRACTION,
} from "../components/DeliveryFlow";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { TerminalIsland } from "../components/TerminalIsland";
import { mono } from "../fonts";
import { colors, motion, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S10Props {
  format: Format;
}

const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S10" && c.kind === "hero")?.text ?? "";

const FLOW_START = 4; // chips depart from local f4 (comp f724)

export function S10({ format }: S10Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const islandWidth = Math.min(1500 * s, W - 2 * m);
  // DeliveryFlow's drawing box sits inside the island body (PANEL_PADDING 32/side).
  const flowWidth = islandWidth - 64;
  const flowHeight = 300 * s;

  // Labels fade in local f10–26.
  const labelOpacity = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const labelBase = {
    position: "absolute" as const,
    fontFamily: mono,
    fontSize: type.badge.fontSize * s * 0.8,
    color: colors.termDim,
    opacity: labelOpacity,
    whiteSpace: "pre" as const,
    transform: "translateX(-50%)",
  };

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 48 * s }}>
        <TerminalIsland
          header="wbhk listen"
          width={islandWidth}
          enterAtFrame={-motion.railsDurationFrames}
        >
          <div style={{ position: "relative", width: flowWidth, height: flowHeight }}>
            <DeliveryFlow startFrame={FLOW_START} width={flowWidth} height={flowHeight} />

            {/* Labels pinned to the motif geometry via the exported fractions. */}
            <span
              style={{
                ...labelBase,
                left: (QUEUE_X_FRACTION + 0.14) * flowWidth,
                top: TRACK_Y_FRACTION * flowHeight - 46 * s,
              }}
            >
              FIFO per endpoint
            </span>
            <span
              style={{
                ...labelBase,
                left: RETRY_ZONE_X_FRACTION * flowWidth,
                top: TRACK_Y_FRACTION * flowHeight + 30 * s,
              }}
            >
              retries
            </span>
            <span
              style={{
                ...labelBase,
                left: DEAD_LETTER_X_FRACTION * flowWidth,
                top: DEAD_LETTER_Y_FRACTION * flowHeight + 22 * s,
              }}
            >
              dead-letter
            </span>
          </div>
        </TerminalIsland>

        <div style={{ color: colors.termFg }}>
          <KineticLine text={HERO_TEXT} startFrame={30} size={54 * s} weight={600} align="center" />
        </div>
      </div>
    </AbsoluteFill>
  );
}
