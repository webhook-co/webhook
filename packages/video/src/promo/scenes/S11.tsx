// S11 · frames 810–900 · 0:27–0:30 — replay to localhost (brief §5 S11).
//
// Dark terminal. The replay command "wbhk listen --forward
// http://localhost:3000/webhooks" types 1 char/frame from local f4 (comp f814).
// On "Enter" (the moment the command finishes typing) the reply line "→
// localhost:3000  200" prints; the "200" lands with a mini-thock (§3.4 land pop)
// + a soft ring-pulse echo of the signature thock at local f68 (comp f878). The
// caption "Replay to localhost. One command. No redeploy." settles local f60–90
// (comp f870–900).
//
// Timing note: the command is 52 chars, so at the film's fixed 1 char/frame it
// finishes at local f56 (comp f866) — Enter fires there, ~4 frames after the
// brief's nominal f862. Holding 1 char/frame (brand: real typing speed) over
// matching f862 exactly is the deliberate trade; the money beat — the 200 pop at
// f878 — stays frame-accurate. Authored in scene-local frames.

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { RingPulse } from "../components/RingPulse";
import { TerminalIsland } from "../components/TerminalIsland";
import { isCursorOn, revealedCharCount } from "../components/TypedLine";
import { badgeGlowOpacity, badgePopScale } from "../components/VerifiedBadge";
import { mono } from "../fonts";
import { colors, motion, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S11Props {
  format: Format;
}

const COMMAND = CAPTIONS.find((c) => c.scene === "S11" && c.kind === "command")?.text ?? "";
const CAPTION = CAPTIONS.find((c) => c.scene === "S11" && c.kind === "caption")?.text ?? "";

const TYPE_START = 4; // command types from local f4 (comp f814)
// The real localhost reply (byte-for-byte). The "200" is split out so it can
// land with its own pop while the prefix eases in on Enter.
const REPLY_PREFIX = "→ localhost:3000  ";
const REPLY_CODE = "200";
const TWO_HUNDRED_POP = 68; // the 200 lands local f68 (comp f878)

export function S11({ format }: S11Props) {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const revealed = revealedCharCount(frame, TYPE_START, COMMAND.length);
  const commandShown = COMMAND.slice(0, revealed);
  const typedDone = revealed >= COMMAND.length;
  // Enter fires the instant the command is fully typed.
  const replyStart = TYPE_START + COMMAND.length;

  const cursorOn = isCursorOn(frame);
  const showReply = frame >= replyStart;
  const replyOpacity = interpolate(frame, [replyStart, replyStart + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const showCode = frame >= TWO_HUNDRED_POP;
  const codeScale = showCode ? badgePopScale(frame - TWO_HUNDRED_POP, fps) : 1;
  const codeGlow = showCode ? badgeGlowOpacity(frame - TWO_HUNDRED_POP) : 0;

  const islandWidth = Math.min(1500 * s, W - 2 * m);
  const bodyFont = type.terminalBody.fontSize * s;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 48 * s }}>
        <TerminalIsland
          header="wbhk listen"
          width={islandWidth}
          enterAtFrame={-motion.railsDurationFrames}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: bodyFont,
              lineHeight: 1.6,
              color: colors.termFg,
              whiteSpace: "pre",
            }}
          >
            {/* The replay command types 1 char/frame. */}
            <div>
              <span style={{ color: colors.termDim }}>{"$ "}</span>
              <span>{commandShown}</span>
              {!typedDone ? (
                <span aria-hidden style={{ opacity: cursorOn ? 1 : 0 }}>
                  ▉
                </span>
              ) : null}
            </div>

            {/* Reply line — prints on Enter; the 200 lands with the mini-thock. */}
            {showReply ? (
              <div style={{ opacity: replyOpacity }}>
                <span style={{ color: colors.termDim }}>{REPLY_PREFIX}</span>
                {showCode ? (
                  <span
                    style={{
                      display: "inline-block",
                      color: colors.verified,
                      fontWeight: 600,
                      transform: `scale(${codeScale})`,
                      transformOrigin: "left center",
                      textShadow:
                        codeGlow > 0
                          ? `0 0 ${Math.round(16 * codeGlow)}px ${colors.verifiedGlow}`
                          : "none",
                    }}
                  >
                    {REPLY_CODE}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </TerminalIsland>

        <div style={{ color: colors.termFg }}>
          <KineticLine
            text={CAPTION}
            startFrame={60}
            size={type.caption.fontSize * s}
            weight={type.caption.fontWeight}
            align="center"
          />
        </div>
      </div>

      {/* Soft ring-pulse echo of the signature thock, firing with the 200's land. */}
      <RingPulse atXY={{ x: W / 2, y: H * 0.44 }} startFrame={TWO_HUNDRED_POP} size={200 * s} />
    </AbsoluteFill>
  );
}
