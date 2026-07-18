// S15 · frames 1230–1350 · 0:41–0:45 — the agent parks (brief §5 S15).
//
// The SAME transcript continues (create + its response already settled), then
// the agent issues `triggers.wait` (types local f4→f17, comp f1234→) and PARKS.
// A breathing "waiting" pill appears beneath — NOT a spinner, a durable park:
// its opacity pulses 0.5↔1.0 on a 40-frame period across local f40→f120 (comp
// f1270→f1350, brief's window), a slow held breath while the agent is suspended.
// The pill text "waiting · cursor-acked · at-least-once" is the real status
// string (brief §6.1).
//
// The transcript is anchored so create+response sit in the SAME place they did
// in S14 — this scene simply appends `triggers.wait` beneath them (the negative
// `startFrame` places create/response fully settled before local f0). Accent
// discipline (Act III): the waiting dot is NEUTRAL (termDim) — waiting is not
// verified, and green is reserved for the wake in S16. Authored in scene-local
// frames.

import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

import { CAPTIONS } from "../captions";
import { MCPTranscript } from "../components/MCPTranscript";
import type { MCPTranscriptBlock } from "../components/MCPTranscript";
import { DotsBackground } from "../components/DotsBackground";
import { TerminalIsland } from "../components/TerminalIsland";
import { mono } from "../fonts";
import { colors, motion, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S15Props {
  format: Format;
}

const PILL_TEXT = CAPTIONS.find((c) => c.scene === "S15" && c.kind === "pill")?.text ?? "";

// The full transcript history. `startFrame` is negative so create + response are
// already fully settled at local f0 (see blockStartFrames): with create (15ch,
// 15f), the +10 gap, response (21f slide), the +10 gap, `triggers.wait` begins
// typing at startFrame + 56 — so startFrame = -52 lands its typing at local f4.
const BLOCKS: MCPTranscriptBlock[] = [
  { kind: "call", text: "triggers.create" },
  { kind: "response", text: "sub_0197f0c1..." },
  { kind: "call", text: "triggers.wait" },
];
const TRANSCRIPT_START = -52;

// The park: pill fades in after `triggers.wait` types, then breathes.
const PILL_FADE_IN = 20;
const PILL_FADE_DONE = 32;
const BREATHE_START = 40; // comp f1270
const BREATHE_PERIOD = 40; // ~40-frame slow pulse (brief §5 S15)

export function S15({ format }: S15Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const islandWidth = Math.min(1200 * s, W - 2 * m);

  // Breathing park (deterministic — a pure cosine of the frame, 0.5↔1.0). Before
  // BREATHE_START the pill quietly fades up; both meet at opacity 1.0 at f40.
  const fadeIn = interpolate(frame, [PILL_FADE_IN, PILL_FADE_DONE], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const breathe = 0.75 + 0.25 * Math.cos((2 * Math.PI * (frame - BREATHE_START)) / BREATHE_PERIOD);
  const pillOpacity = frame < BREATHE_START ? fadeIn : breathe;
  const pillVisible = frame >= PILL_FADE_IN;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <TerminalIsland
        header="mcp.webhook.co"
        width={islandWidth}
        enterAtFrame={-motion.railsDurationFrames}
      >
        <div style={{ minHeight: 180 * s }}>
          <MCPTranscript blocks={BLOCKS} startFrame={TRANSCRIPT_START} />

          {/* The breathing "waiting" pill — a durable park, not a spinner. */}
          {pillVisible ? (
            <div
              style={{
                marginTop: 24 * s,
                display: "inline-flex",
                alignItems: "center",
                gap: 12 * s,
                padding: `${10 * s}px ${18 * s}px`,
                borderRadius: 999,
                border: `1px solid ${colors.termBorder}`,
                background: colors.termBg2,
                opacity: pillOpacity,
              }}
            >
              <span
                style={{
                  width: 9 * s,
                  height: 9 * s,
                  borderRadius: "50%",
                  background: colors.termDim,
                }}
              />
              <span
                style={{
                  fontFamily: mono,
                  fontSize: type.badge.fontSize * s,
                  color: colors.termFg,
                }}
              >
                {PILL_TEXT}
              </span>
            </div>
          ) : null}
        </div>
      </TerminalIsland>
    </AbsoluteFill>
  );
}
