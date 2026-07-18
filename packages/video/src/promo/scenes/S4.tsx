// S4 · frames 210–300 · 0:07–0:10 — the live listen line (brief §5 S4).
//
// A flat term-bg terminal island expands to fill; the real `wbhk listen` output
// line prints 1 char/frame from scene-local f4 (comp f214). The `verified`
// substring renders in --verified with a brief scale-pop + glow as it lands
// (§3.4 land spring). The caption fades up local f60–90 (comp f270–300).
//
// The output line can't route through the mono TypedLine component (that colors
// the whole string uniformly), so this scene drives the same reveal math via
// the exported `revealedCharCount` / `isCursorOn` helpers and colors the
// `verified` slice itself. Authored in scene-local frames.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { TerminalIsland } from "../components/TerminalIsland";
import { isCursorOn, revealedCharCount } from "../components/TypedLine";
import { badgeGlowOpacity, badgePopScale } from "../components/VerifiedBadge";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S4Props {
  format: Format;
}

const OUTPUT = CAPTIONS.find((c) => c.scene === "S4" && c.kind === "output")?.text ?? "";
const CAPTION = CAPTIONS.find((c) => c.scene === "S4" && c.kind === "caption")?.text ?? "";

// Typing begins local f4 (comp f214). "verified" is the highlighted substring.
const TYPE_START = 4;
const VERIFIED = "verified";

export function S4({ format }: S4Props) {
  const frame = useCurrentFrame();
  const { width: W, fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const idx = OUTPUT.indexOf(VERIFIED);
  const verifiedEnd = idx + VERIFIED.length;
  const revealed = revealedCharCount(frame, TYPE_START, OUTPUT.length);

  const before = OUTPUT.slice(0, Math.min(revealed, idx));
  const verifiedShown = revealed > idx ? OUTPUT.slice(idx, Math.min(revealed, verifiedEnd)) : "";
  const after = revealed > verifiedEnd ? OUTPUT.slice(verifiedEnd, revealed) : "";

  // The verified slice pops the instant it finishes typing (§3.4 land spring).
  const popRel = frame - (TYPE_START + verifiedEnd);
  const vScale = popRel >= 0 ? badgePopScale(popRel, fps) : 1;
  const vGlow = popRel >= 0 ? badgeGlowOpacity(popRel) : 0;

  const cursorOn = isCursorOn(frame);
  const fontSize = type.terminalBody.fontSize * s;

  // The island "expands to fill" across the entrance (§5 S4).
  const islandWidth = interpolate(frame, [0, 24], [W * 0.5, W - 2 * m], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 48 * s }}>
        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <TerminalIsland header="wbhk listen" width={islandWidth} raised={false} enterAtFrame={0}>
            <div
              style={{
                fontFamily: mono,
                fontSize,
                lineHeight: type.terminalBody.lineHeight,
                color: colors.termFg,
                whiteSpace: "pre",
              }}
            >
              <span>{before}</span>
              <span
                style={{
                  display: "inline-block",
                  color: colors.verified,
                  transform: `scale(${vScale})`,
                  transformOrigin: "left center",
                  textShadow:
                    vGlow > 0 ? `0 0 ${Math.round(16 * vGlow)}px ${colors.verifiedGlow}` : "none",
                }}
              >
                {verifiedShown}
              </span>
              <span>{after}</span>
              <span aria-hidden style={{ opacity: cursorOn ? 1 : 0 }}>
                ▉
              </span>
            </div>
          </TerminalIsland>
        </div>

        {/* Caption fades up f270–300 (Inter, dim). */}
        <div style={{ color: colors.termDim }}>
          <KineticLine
            text={CAPTION}
            startFrame={60}
            size={type.caption.fontSize * s}
            weight={type.caption.fontWeight}
            align="center"
          />
        </div>
      </div>
    </AbsoluteFill>
  );
}
