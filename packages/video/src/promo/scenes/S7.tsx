// S7 · frames 450–540 · 0:15–0:18 · ★ MONEY FRAME #2 (brief §5 S7).
//
// The defensible wedge. A slow ~4% camera push into the card (a wrapping
// AbsoluteFill transform, ≤ motion.cameraPushMax). At local f0 (comp f450) one
// field of the JSON body highlights colors.failed — a re-serialized byte. The
// badge desaturates verified-green → neutral → colors.failed across local f6–22
// (comp f456–472). "RAW_BODY_MODIFIED" (mono, prominent, page ink) types in
// local f24–41 (comp f474–491), and the plain-English fix line fades in
// word-by-word beneath it, completing by local f70 (comp f520) — the export
// still #2 hold. This red mutation is one of the film's two sanctioned non-green
// moments (brief §3.1). Authored in scene-local frames.

import { AbsoluteFill, Easing, interpolate, interpolateColors, useCurrentFrame } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { isCursorOn, revealedCharCount } from "../components/TypedLine";
import { inter, mono } from "../fonts";
import { colors, motion, radii, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S7Props {
  format: Format;
}

const CODE_TEXT = CAPTIONS.find((c) => c.scene === "S7" && c.kind === "code")?.text ?? "";
const FIX_TEXT = CAPTIONS.find((c) => c.scene === "S7" && c.kind === "caption")?.text ?? "";

// Mirrors DashboardCard's local light-card shadow (that constant isn't exported;
// it's documented there as a deliberate light-theme local exception to
// shadows.terminal, which is tuned for the dark panel). Kept in sync here so the
// mutating S7 card reads as the same surface the S6 <DashboardCard> established.
const CARD_SHADOW = "0 1px 2px rgba(11,13,16,0.04), 0 12px 32px rgba(11,13,16,0.08)";

// Illustrative JSON body (brief §5 S5 precedent: illustrative payload, no
// invented secrets). MUTATED_LINE is the re-serialized field that flips red.
const BODY_LINES = [
  "{",
  '  "type": "issue.updated",',
  '  "id": "0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21",',
  '  "data": { "state": "started" }',
  "}",
] as const;
const MUTATED_LINE = 3;

const TYPE_START = 24; // RAW_BODY_MODIFIED types local f24 (comp f474)
const BADGE_FLIP_START = 6;
const BADGE_FLIP_MID = 14;
const BADGE_FLIP_END = 22;
const FIX_START = 50;
const FIX_WORD_STEP = 2; // per-word stagger — completes the line by local f70 (the hold)
const FIX_WORD_FADE = 4;

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

export function S7({ format }: S7Props) {
  const frame = useCurrentFrame();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // ≤4% camera push into the card (brief §3.4 cameraPushMax).
  const push = interpolate(frame, [0, 60], [0, motion.cameraPushMax], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Badge desaturates green → neutral → failed (brief §5 S7). interpolateColors
  // clamps at the edges, so it holds verified before f6 and failed after f22.
  const dotColor = interpolateColors(
    frame,
    [BADGE_FLIP_START, BADGE_FLIP_MID, BADGE_FLIP_END],
    [colors.verified, colors.unattempted, colors.failed],
  );
  const badgeState = frame < BADGE_FLIP_MID ? "verified" : "failed";

  // RAW_BODY_MODIFIED types in 1 char/frame (mono).
  const codeRevealed = revealedCharCount(frame, TYPE_START, CODE_TEXT.length);
  const codeShown = CODE_TEXT.slice(0, codeRevealed);
  const codeTyping = frame >= TYPE_START && codeRevealed < CODE_TEXT.length;
  const cursorOn = isCursorOn(frame);

  const fixWords = FIX_TEXT.split(" ");

  const cardWidth = Math.min(760 * s, 1920 - 2 * m);
  const bodyFont = 26 * s;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${1 + push})`,
          transformOrigin: "center center",
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 40 * s }}
        >
          {/* The mutating card — same event, now failed. */}
          <div
            style={{
              width: cardWidth,
              display: "flex",
              flexDirection: "column",
              gap: 20 * s,
              padding: 28 * s,
              borderRadius: radii.terminal,
              border: `1px solid ${colors.pageBorder}`,
              background: colors.pagePanel,
              boxShadow: CARD_SHADOW,
            }}
          >
            {/* Header: provider + the flipping badge. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  fontFamily: mono,
                  fontSize: type.terminalBody.fontSize * s,
                  color: colors.pageInk,
                }}
              >
                linear
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 * s }}>
                <span
                  style={{
                    width: 12 * s,
                    height: 12 * s,
                    borderRadius: "50%",
                    background: dotColor,
                  }}
                />
                <span
                  style={{
                    ...type.badge,
                    fontFamily: mono,
                    fontSize: type.badge.fontSize * s,
                    color: colors.pageInk,
                  }}
                >
                  {badgeState}
                </span>
              </span>
            </div>

            {/* JSON body — one re-serialized field highlights red from local f0. */}
            <div
              style={{
                background: colors.pageBg,
                border: `1px solid ${colors.pageBorder}`,
                borderRadius: 10 * s,
                padding: 20 * s,
                fontFamily: mono,
                fontSize: bodyFont,
                lineHeight: 1.5,
                whiteSpace: "pre",
              }}
            >
              {BODY_LINES.map((line, i) => {
                const mutated = i === MUTATED_LINE;
                return (
                  <div
                    key={i}
                    style={{
                      color: mutated ? colors.failed : colors.pageInk,
                      background: mutated ? "rgba(248,81,73,0.10)" : "transparent",
                      borderLeft: mutated ? `2px solid ${colors.failed}` : "2px solid transparent",
                      paddingLeft: 8 * s,
                    }}
                  >
                    {line}
                  </div>
                );
              })}
            </div>
          </div>

          {/* RAW_BODY_MODIFIED (mono, prominent) + fix line (dim, word-by-word). */}
          <div
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 * s }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 44 * s,
                fontWeight: 600,
                letterSpacing: "0.02em",
                color: colors.pageInk,
                whiteSpace: "pre",
              }}
            >
              {codeShown}
              {codeTyping ? (
                <span aria-hidden style={{ opacity: cursorOn ? 1 : 0 }}>
                  ▉
                </span>
              ) : null}
            </span>
            <span
              style={{
                fontFamily: inter,
                fontSize: type.caption.fontSize * s,
                color: colors.pageDim,
                textAlign: "center",
              }}
            >
              {fixWords.map((word, i) => {
                const wordStart = FIX_START + i * FIX_WORD_STEP;
                const wordOpacity = interpolate(
                  frame,
                  [wordStart, wordStart + FIX_WORD_FADE],
                  [0, 1],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                );
                return (
                  <span key={i} style={{ opacity: wordOpacity }}>
                    {word}
                    {i < fixWords.length - 1 ? " " : ""}
                  </span>
                );
              })}
            </span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
