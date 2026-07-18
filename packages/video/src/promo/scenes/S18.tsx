// S18 · frames 1560–1650 · 0:52–0:55 — the hero headline resolves (brief §5 S18).
//
// ACT IV opens: pull back to the light page (`--page-bg` + <DotsBackground
// theme="light">). The live hero headline — "The webhook platform built for the
// agent era." — mask-reveals LINE BY LINE across local f4→f50 (comp f1564→1610),
// each line settling as a unit with the brief §3.4 headline-settle spring (no
// bounce). The one `colors.verified` accent carries as the SOLE saturated color
// on the light page: the sentence's final period, in green — the same green "."
// the <Wordmark> lockup carries in S19/S20, so the close rhymes.
//
// The headline text is pulled from CAPTIONS byte-for-byte and split into two
// lines purely for the line-by-line reveal; line1 + " " + line2 + "." rebuilds
// the exact caption string. Authored in scene-local frames (PromoMaster
// time-shifts this via <Sequence from={1560}>, so useCurrentFrame() reads 0 at
// the scene start). Hero rendering is hand-rolled per the S1 precedent (the same
// spring + interpolate) so the trailing period can carry its own green span
// while the rest of its line settles with it.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { inter } from "../fonts";
import { colors, springs, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S18Props {
  format: Format;
}

// The live hero headline, byte-for-byte from CAPTIONS.
const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S18" && c.kind === "hero")?.text ?? "";
// Strip the trailing period (carried separately as the single green accent),
// then split the remainder into two reveal lines. Together they reconstruct the
// caption exactly: LINE1 + " " + LINE2 + "." === HERO_TEXT.
const HERO_BODY = HERO_TEXT.replace(/\.$/, "");
const HERO_WORDS = HERO_BODY.split(" ");
const LINE1 = HERO_WORDS.slice(0, 3).join(" "); // "The webhook platform"
const LINE2 = HERO_WORDS.slice(3).join(" "); // "built for the agent era"

// Line-by-line reveal starts (brief window local f4→f50): the second line
// follows the first so the headline reads as two settling breaths, not one cut.
const LINE1_START = 4;
const LINE2_START = 20;

export function S18({ format }: S18Props) {
  const frame = useCurrentFrame();
  const { width: W, fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];
  const avail = W - 2 * m;

  // Full hero size, capped so the longest line stays inside the title-safe box.
  const heroSize = Math.min(type.hero.fontSize * s, avail / 12);

  // The brief §3.4 headline-settle spring (no bounce), per line.
  const settle = (start: number) => {
    const progress = spring({ fps, frame: frame - start, config: springs.headlineSettle });
    const opacity = interpolate(progress, [0, 1], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const translateY = interpolate(progress, [0, 1], [12, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return { opacity, transform: `translateY(${translateY}px)` };
  };

  const lineStyle = {
    fontFamily: inter,
    fontSize: heroSize,
    fontWeight: type.hero.fontWeight,
    letterSpacing: type.hero.letterSpacing,
    lineHeight: 1.08,
    color: colors.pageInk,
  } as const;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8 * s,
          textAlign: "center",
          maxWidth: avail,
        }}
      >
        {/* Line 1 — settles first. */}
        <div style={{ ...lineStyle, ...settle(LINE1_START) }}>{LINE1}</div>

        {/* Line 2 — settles just after; its final period is the film's one
            saturated accent on the light page (green, rhyming with the wordmark). */}
        <div style={{ ...lineStyle, ...settle(LINE2_START) }}>
          {LINE2}
          <span style={{ color: colors.verified }}>.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
