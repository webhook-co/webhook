// S8 · frames 540–630 · 0:18–0:21 — the named reason replaces the useless one (brief §5 S8).
//
// The industry-standard useless string — "no signatures found matching the
// expected signature" — is struck through (the strikethrough draws left→right
// local f0–20 = comp f540–560). RAW_BODY_MODIFIED then snaps in over it at local
// f20 (comp f560) with the §3.4 land pop — webhook.co's named cause. The caption
// "When a signature fails, you'll know why." settles local f40–70 (comp
// f580–610). Light theme. Authored in scene-local frames.

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { badgePopScale } from "../components/VerifiedBadge";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S8Props {
  format: Format;
}

const STRIKE_TEXT = CAPTIONS.find((c) => c.scene === "S8" && c.kind === "strike")?.text ?? "";
const CAPTION_TEXT = CAPTIONS.find((c) => c.scene === "S8" && c.kind === "caption")?.text ?? "";
// The replacement is S7's named cause, reused verbatim (brief §5 S8).
const CODE_TEXT = CAPTIONS.find((c) => c.scene === "S7" && c.kind === "code")?.text ?? "";

const STRIKE_END = 20;
const CODE_IN = 20; // named reason snaps in at local f20 (comp f560)

export function S8({ format }: S8Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // Strikethrough draws left→right across the useless string, local f0–20.
  const strikeWidth = interpolate(frame, [0, STRIKE_END], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Named reason snaps in over it at local f20 (§3.4 land pop).
  const codeVisible = frame >= CODE_IN;
  const codeScale = codeVisible ? badgePopScale(frame - CODE_IN, fps) : 1;

  const maxWidth = Math.min(1500 * s, 1920 - 2 * m);
  const strikeSize = 34 * s;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40 * s,
          maxWidth,
          textAlign: "center",
        }}
      >
        {/* The useless industry-standard string, struck through. */}
        <div style={{ position: "relative", display: "inline-block" }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: strikeSize,
              color: colors.pageDim,
              whiteSpace: "pre",
            }}
          >
            {STRIKE_TEXT}
          </span>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: "50%",
              width: `${strikeWidth}%`,
              height: 2,
              background: colors.pageDim,
            }}
          />
        </div>

        {/* RAW_BODY_MODIFIED snaps in over it — the named cause. */}
        <span
          style={{
            fontFamily: mono,
            fontSize: 56 * s,
            fontWeight: 600,
            letterSpacing: "0.02em",
            color: colors.pageInk,
            opacity: codeVisible ? 1 : 0,
            transform: `scale(${codeScale})`,
          }}
        >
          {CODE_TEXT}
        </span>

        {/* Caption settles local f40–70. */}
        <div style={{ color: colors.pageInk }}>
          <KineticLine
            text={CAPTION_TEXT}
            startFrame={40}
            size={type.caption.fontSize * s}
            weight={type.caption.fontWeight}
            align="center"
          />
        </div>
      </div>
    </AbsoluteFill>
  );
}
