// S9 · frames 630–720 · 0:21–0:24 — the four-state legend (brief §5 S9).
//
// The film's second sanctioned non-green moment (brief §3.1): the four
// verification states shown together — verified (green) · authenticated (amber)
// · failed (red) · unattempted (grey). Rows stagger in top→bottom on a 4-frame
// cadence from local f6 (comp f636); each <VerifiedBadge> fades its dot + label
// up (0→100%) as its row lands. Light theme, dark ink labels. Authored in
// scene-local frames.

import { AbsoluteFill } from "remotion";

import { DotsBackground } from "../components/DotsBackground";
import { VerifiedBadge } from "../components/VerifiedBadge";
import type { VerifiedState } from "../components/VerifiedBadge";
import { colors, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S9Props {
  format: Format;
}

// Order + colors per brief §5 S9 / §6.1 legend (verified · authenticated ·
// failed · unattempted). VerifiedBadge maps each state to its own token color.
const STATES: readonly VerifiedState[] = ["verified", "authenticated", "failed", "unattempted"];
const STAGGER_START = 6; // local f6 (comp f636)
const STAGGER_STEP = 4;
// Legend presence: scale the fixed badge type up so the four states read large
// and generously spaced (brief §5 S9), then ×verticalScale for the 9:16 cut.
const LEGEND_SCALE = 1.9;

export function S9({ format }: S9Props) {
  const s = format === "9x16" ? verticalScale : 1;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 40,
          color: colors.pageInk,
          transform: `scale(${LEGEND_SCALE * s})`,
        }}
      >
        {STATES.map((state, i) => (
          <VerifiedBadge key={state} state={state} startFrame={STAGGER_START + i * STAGGER_STEP} />
        ))}
      </div>
    </AbsoluteFill>
  );
}
