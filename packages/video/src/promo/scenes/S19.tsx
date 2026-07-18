// S19 · frames 1650–1740 · 0:55–0:58 — signature line + wordmark (brief §5 S19).
//
// On the light page (`--page-bg` + <DotsBackground theme="light">): the film's
// signature line — "Send a webhook. Watch it land." (the S1/S3 bookend, now
// resolved as one line) — settles above across local f4→f30 (comp f1654→1680),
// then the <Wordmark> lockup fades up below across local f35→f65 (comp
// f1685→1715). One last, faint <RingPulse> radiates behind the mark as it
// lands — the final echo of the "land" motif. The wordmark's green "." is the
// one saturated accent on the light page.
//
// AUDIO (follow-up, no asset here): the fullest signature "thock" + tail reverb
// lands at comp f1660 (local f10) per the brief §7 cue sheet — a later pass
// wires a <SfxCue atFrame={10}> here; this scene leaves only the timing marker.
//
// Authored in scene-local frames (PromoMaster time-shifts via <Sequence
// from={1650}>). Reuses <KineticLine>, <Wordmark>, <RingPulse>, <DotsBackground>.

import { AbsoluteFill, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { RingPulse } from "../components/RingPulse";
import { Wordmark } from "../components/Wordmark";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S19Props {
  format: Format;
}

// The signature line, byte-for-byte from CAPTIONS.
const SIGNATURE_TEXT = CAPTIONS.find((c) => c.scene === "S19" && c.kind === "hero")?.text ?? "";

const SIGNATURE_START = 4; // local f4 (comp f1654)
const WORDMARK_START = 35; // fades up local f35 (comp f1685)
// The last, faint land radiate — fires just as the wordmark settles (comp f1660
// is the audio thock; the ring is a visual echo behind the mark).
const RING_START = 40;

// The wordmark's fixed-size wrapper — gives <RingPulse> a known center to
// radiate from, precisely behind the mark (mirrors S16's block-local ring).
const MARK_BOX_W = 380;
const MARK_BOX_H = 132;

export function S19({ format }: S19Props) {
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];
  const avail = W - 2 * m;

  const markBoxW = MARK_BOX_W * s;
  const markBoxH = MARK_BOX_H * s;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40 * s,
          maxWidth: avail,
          color: colors.pageInk,
        }}
      >
        {/* Signature line — settles first (dark ink on the light page). */}
        <KineticLine
          text={SIGNATURE_TEXT}
          startFrame={SIGNATURE_START}
          size={Math.min(type.caption.fontSize * s * 1.25, avail / 12)}
          weight={600}
          align="center"
        />

        {/* Wordmark below, with the last faint ring-pulse radiating behind it.
            The relative box gives the ring a known center to fire from. */}
        <div
          style={{
            position: "relative",
            width: markBoxW,
            height: markBoxH,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <RingPulse
            atXY={{ x: markBoxW / 2, y: markBoxH / 2 }}
            startFrame={RING_START}
            size={220 * s}
          />
          {/* size defaults to 56 at s=1 (the literal <Wordmark startFrame /> call);
              multiplied by `s` only so the 9:16 cut scales with the rest. */}
          <Wordmark startFrame={WORDMARK_START} size={56 * s} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
