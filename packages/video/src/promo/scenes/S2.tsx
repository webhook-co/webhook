// S2 · frames 90–150 · 0:03–0:05 — anticipation (brief §5 S2).
//
// The ingest pill docks top-right (enters scene-local f0 = comp f90); a `POST`
// chip sits bottom-left; a glowing packet arcs POST → pill, accelerating, and
// snaps into the pill at comp f144 (scene-local f54). onLandFrame is held to
// local f60 (comp f150) so the packet settles for the brief's "6 frames of
// near-silence" before S3's THOCK, rather than dissolving on arrival.
//
// Coordinates are derived from useVideoConfig() so the same scene works for
// both the 16:9 master and the 9:16 cut. Authored in scene-local frames.

import { AbsoluteFill, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { IngestPill } from "../components/IngestPill";
import { Packet } from "../components/Packet";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S2Props {
  format: Format;
}

const PILL_URL = CAPTIONS.find((c) => c.scene === "S2" && c.kind === "pill")?.text ?? "";

// Packet timing (scene-local): begins f10 (comp f100), 44f travel → arrival f54
// (comp f144); land beat held to f60 (comp f150), the S3 THOCK frame.
const PACKET_START = 10;
const PACKET_DURATION = 44;
const PACKET_LAND = 60;

export function S2({ format }: S2Props) {
  const { width: W, height: H } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // Approximate visual centers for the docked pill (top-right) and POST chip
  // (bottom-left); the packet arcs between them. Exactness is not load-bearing —
  // S3's land visuals (row + ring) are what read on impact.
  const pillCenter = { x: W - m - 190 * s, y: m + 30 * s };
  const postCenter = { x: m + 60 * s, y: H - 210 * s };

  return (
    <AbsoluteFill>
      <DotsBackground theme="dark" />

      {/* Ingest pill — docked top-right. The pill owns its own entrance settle. */}
      <div style={{ position: "absolute", top: m, right: m }}>
        <IngestPill url={PILL_URL} startFrame={0} />
      </div>

      {/* POST chip — bottom-left. HTTP verb stays uppercase (not a brand name). */}
      <div
        style={{ position: "absolute", left: m, top: postCenter.y, transform: "translateY(-50%)" }}
      >
        <span
          style={{
            ...type.badge,
            fontSize: type.badge.fontSize * s,
            textTransform: "none",
            fontFamily: mono,
            color: colors.termFg,
            background: colors.termBg2,
            border: `1px solid ${colors.termBorder}`,
            borderRadius: 8,
            padding: "8px 16px",
          }}
        >
          POST
        </span>
      </div>

      {/* The request packet arcs into the pill. */}
      <Packet
        fromXY={postCenter}
        toXY={pillCenter}
        startFrame={PACKET_START}
        durationFrames={PACKET_DURATION}
        onLandFrame={PACKET_LAND}
      />
    </AbsoluteFill>
  );
}
