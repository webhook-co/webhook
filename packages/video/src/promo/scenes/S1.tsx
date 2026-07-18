// S1 · frames 0–90 · 0:00–0:03 — the cold open (brief §5 S1).
//
// Full-frame term-bg + drifting dots. A mono `$` prompt with a blinking block
// cursor sits above the kinetic hero line. "Send a webhook." reveals word by
// word from f20 with the brief's no-bounce headline-settle spring (§3.4), each
// word staggered ~18f apart (matching the f20/f38/f56 key-tap cue sheet). Holds
// f70–90. The hero line uses Inter — NOT the mono TypedLine — per the §5 S1 note:
// the two hero lines are "voice", separated from the mono product output.
//
// Authored in scene-local frames: PromoMaster time-shifts this via <Sequence
// from={0}>, so useCurrentFrame() reads 0 at the scene start.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { isCursorOn } from "../components/TypedLine";
import { inter, mono } from "../fonts";
import { colors, springs, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S1Props {
  format: Format;
}

const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S1" && c.kind === "hero")?.text ?? "";

// One reveal start per word (brief cue sheet: soft key-tap at f20, f38, f56).
const WORD_STARTS = [20, 38, 56];

export function S1({ format }: S1Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;

  const words = HERO_TEXT.split(" ");
  const cursorOn = isCursorOn(frame);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />
      <div style={{ position: "relative", textAlign: "center" }}>
        {/* Terminal prompt — mono, dim, with a 2Hz block cursor from f0. */}
        <div
          style={{
            ...type.badge,
            fontSize: type.badge.fontSize * s,
            fontFamily: mono,
            color: colors.termDim,
            marginBottom: 40 * s,
          }}
        >
          {"$ "}
          <span aria-hidden style={{ opacity: cursorOn ? 1 : 0 }}>
            ▉
          </span>
        </div>

        {/* Hero line — Inter, word-by-word settle (§3.4 headlineSettle, no bounce). */}
        <div
          style={{
            fontFamily: inter,
            fontSize: type.hero.fontSize * s,
            fontWeight: type.hero.fontWeight,
            letterSpacing: type.hero.letterSpacing,
            color: colors.termFg,
            lineHeight: 1.1,
          }}
        >
          {words.map((word, i) => {
            const start = WORD_STARTS[i] ?? WORD_STARTS[WORD_STARTS.length - 1] ?? 20;
            const progress = spring({ fps, frame: frame - start, config: springs.headlineSettle });
            const opacity = interpolate(progress, [0, 1], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const translateY = interpolate(progress, [0, 1], [12, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  opacity,
                  transform: `translateY(${translateY}px)`,
                  marginRight: i < words.length - 1 ? "0.28em" : 0,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
