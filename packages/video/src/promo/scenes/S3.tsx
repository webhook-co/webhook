// S3 · frames 150–210 · 0:05–0:07 · ★ MONEY FRAME #1 (brief §5 S3).
//
// The impact. An event row slams into existence at scene-local f0 (comp f150,
// THE THOCK) with the §3.4 overshoot spring; a ring-pulse radiates behind it
// f0–24; the row's `verified` badge pops + glows. "Watch it land." resolves
// bottom-center, settling local f2–22 (comp f152–172). From local f36 (comp
// f186) everything is at rest — the freeze-hold that is export still #1.
//
// The row + headline are centered for legibility (the money frame the whole
// thesis rests on) rather than pinned to S2's top-right pill; the packet's arc
// reads as "it landed, here is the event". Authored in scene-local frames.

import { AbsoluteFill, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { EventRow } from "../components/EventRow";
import { KineticLine } from "../components/KineticLine";
import { RingPulse } from "../components/RingPulse";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S3Props {
  format: Format;
}

const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S3" && c.kind === "hero")?.text ?? "";

// Real listen fields (brief §5 S3 / §6.1 EVENTS_TABLE row 1), byte-for-byte.
const ROW = {
  received: "2026-07-12T14:02:11.840Z",
  provider: "linear",
  state: "verified",
  id: "0197f0c1-...",
} as const;

export function S3({ format }: S3Props) {
  const { width: W, height: H } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const rowY = H * 0.3;
  const rowWidth = Math.min(1200 * s, W - 2 * m);
  const heroSize = type.hero.fontSize * s;

  return (
    <AbsoluteFill>
      <DotsBackground theme="dark" />

      {/* Land radiate — fires with the row at local f0 (comp f150). */}
      <RingPulse atXY={{ x: W / 2, y: rowY + 22 * s }} startFrame={0} size={220 * s} />

      {/* The event row slams in; `highlight` pops + glows its verified badge. */}
      <div
        style={{
          position: "absolute",
          top: rowY,
          left: W / 2,
          transform: "translate(-50%, -50%)",
          width: rowWidth,
        }}
      >
        <EventRow
          received={ROW.received}
          provider={ROW.provider}
          state={ROW.state}
          id={ROW.id}
          startFrame={0}
          highlight
        />
      </div>

      {/* "Watch it land." resolves bottom-center on the land frame. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: H * 0.72,
          display: "flex",
          justifyContent: "center",
          color: colors.termFg,
        }}
      >
        <KineticLine text={HERO_TEXT} startFrame={2} size={heroSize} weight={600} align="center" />
      </div>
    </AbsoluteFill>
  );
}
