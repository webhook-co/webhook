// IngestPill — rounded pill showing an ingest URL (brief §3.3 / §4.6).
//
// A small terminal-chrome pill (e.g. S2's `https://wbhk.my/whep_abc`, docked
// top-right). This component owns only its own chrome + entrance settle —
// SCREEN POSITION (top-right docking, vertical-cut placement, etc.) is the
// scene's responsibility via a positioned wrapper, matching the brief's props
// list (`{ url; startFrame }`, no coordinates).
//
// The URL renders byte-for-byte in JetBrains Mono — never substitute a
// proportional font for a real product string (brief §3.2). Entrance uses the
// exact §3.4 headline-settle spring (no bounce): translateY(12→0) + opacity(0→1).

import { spring, useCurrentFrame, useVideoConfig } from "remotion";

import { mono } from "../fonts";
import { colors, springs, type } from "../tokens";

type IngestPillProps = {
  /** The ingest URL, rendered byte-for-byte (e.g. "https://wbhk.my/whep_abc"). */
  url: string;
  /** Frame the pill begins its entrance settle. */
  startFrame: number;
};

export const IngestPill = ({ url, startFrame }: IngestPillProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < startFrame) {
    return null;
  }

  // headlineSettle is overdamped (damping: 200) — output is monotonic 0→1, no
  // overshoot, so it can drive opacity/translateY directly without re-clamping.
  const settle = spring({
    fps,
    frame: frame - startFrame,
    config: springs.headlineSettle,
  });

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "10px 20px",
        borderRadius: 999,
        background: colors.termBg2,
        border: `1px solid ${colors.termBorder}`,
        opacity: settle,
        transform: `translateY(${12 * (1 - settle)}px)`,
      }}
    >
      <span style={{ fontFamily: mono, color: colors.termFg, ...type.badge }}>{url}</span>
    </div>
  );
};
