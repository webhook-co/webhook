// S20 · frames 1740–1800 · 0:58–1:00 — the end card (brief §5 S20).
//
// The film's minimal off-white close (`--page-bg` + <DotsBackground
// theme="light">): the small <Wordmark> lockup, a <TrustBand> line beneath —
// "Open source · Apache-2.0 · Private by default" (real trust facts, byte-for-
// byte from CAPTIONS) — and a smaller second line, github.com/webhook-co (a
// real, lowercase repo URL). Both the wordmark and the trust row settle in over
// the first ~half-second, then the card HOLDS static; a mono block cursor blinks
// ONCE at comp f1770 (local f30) as the final punctuation.
//
// Accent discipline: the wordmark's green "." is the one saturated color; the
// trust icons/labels and repo line are `--page-ink`/`--page-dim` only (the
// LIGHT-mode TrustBand variant, not the §3.3 inverse dark strip — Act IV is
// committed to the minimal off-white close). Authored in scene-local frames
// (PromoMaster time-shifts via <Sequence from={1740}>).

import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { TrustBand } from "../components/TrustBand";
import type { TrustBandItem, TrustIconKind } from "../components/TrustBand";
import { Wordmark } from "../components/Wordmark";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S20Props {
  format: Format;
}

// The trust line, byte-for-byte from CAPTIONS, split on its own " · " dividers
// into the three real facts. The TrustBand re-inserts the middot dividers.
const TRUST_TEXT = CAPTIONS.find((c) => c.scene === "S20" && c.kind === "trust")?.text ?? "";
const TRUST_LABELS = TRUST_TEXT.split(" · ");
// Icon per fact, in caption order: open source → github, Apache-2.0 → scale,
// private by default → lock (brief §3.3 / §4.13 glyph set).
const TRUST_ICONS: readonly TrustIconKind[] = ["github", "scale", "lock"];
const TRUST_ITEMS: readonly TrustBandItem[] = TRUST_LABELS.map((label, i) => ({
  icon: TRUST_ICONS[i] ?? "github",
  label,
}));

// A real, lowercase repo URL (the optional smaller second line, brief §5 S20).
const REPO_URL = "github.com/webhook-co";

const WORDMARK_START = 2; // settles in immediately as the card opens
const TRUST_START = 8; // the trust row staggers in just after the mark
const REPO_START = 16; // the repo line follows

// The single cursor blink (brief §5 S20: "a cursor blinks once at f1770" =
// local f30): the block cursor is visible for one ~0.4s pulse, then gone.
const BLINK_ON = 28;
const BLINK_OFF = 40;

export function S20({ format }: S20Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];
  const avail = W - 2 * m;

  const repoOpacity = frame >= REPO_START ? 1 : 0;
  const cursorOn = frame >= BLINK_ON && frame < BLINK_OFF;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      {/* position:relative promotes the whole card above the absolutely-
          positioned <DotsBackground> so every child paints over it — including
          plain (non-transformed) rows like the repo line below (the S1 pattern;
          transformed children such as <Wordmark>/<TrustBand> self-promote). */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 32 * s,
          maxWidth: avail,
        }}
      >
        {/* Small wordmark — the S20 end-card scale (brief: "wordmark small"). */}
        <Wordmark startFrame={WORDMARK_START} size={40 * s} />

        {/* Trust row — light-mode variant, staggered settle. */}
        <TrustBand items={TRUST_ITEMS} startFrame={TRUST_START} scale={s} />

        {/* Smaller second line: the repo URL + the single closing cursor blink. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4 * s,
            opacity: repoOpacity,
            fontFamily: mono,
            fontSize: type.trustFooter.fontSize * s * 0.82,
            color: colors.pageDim,
          }}
        >
          <span>{REPO_URL}</span>
          <span aria-hidden style={{ opacity: cursorOn ? 1 : 0, color: colors.pageDim }}>
            ▉
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
