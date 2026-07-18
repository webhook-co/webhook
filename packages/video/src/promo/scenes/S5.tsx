// S5 · frames 300–360 · 0:10–0:12 — the captured request (brief §5 S5).
//
// The terminal unfolds downward (scaleY from the top) to reveal a captured
// request: a header block (keys --term-dim, values --term-fg) over a short JSON
// body panel (--term-bg-2). Unfold runs local f0–20 (comp f300–320); a single
// faint --wire scanline sweeps headers → body local f20–50 (comp f320–350),
// reading as "captured whole". Micro-caption fades in from local f30 (comp
// f330). Strings are terse + illustrative — standard headers and a two-field
// body reusing the real event id; no invented provider secrets. Scene-local.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { TerminalIsland } from "../components/TerminalIsland";
import { mono } from "../fonts";
import { colors, motion, radii, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S5Props {
  format: Format;
}

const CAPTION = CAPTIONS.find((c) => c.scene === "S5" && c.kind === "caption")?.text ?? "";

// Illustrative captured request — standard HTTP/webhook headers (no secrets) and
// a terse JSON body reusing the film's real event id for continuity.
const HEADERS: readonly [string, string][] = [
  ["content-type", "application/json"],
  ["user-agent", "linear-webhook/1.0"],
  ["webhook-id", "0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21"],
  ["received-at", "2026-07-12T14:02:11.840Z"],
];

const BODY_LINES: readonly string[] = [
  "{",
  '  "type": "issue.updated",',
  '  "id": "0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21"',
  "}",
];

export function S5({ format }: S5Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  const unfold = interpolate(frame, [0, 20], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sweep = interpolate(frame, [20, 50], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const islandWidth = Math.min(1400 * s, W - 2 * m);
  const bodyFont = 26 * s;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 48 * s }}>
        {/* Island is already present (S4 → S5 is a continuous terminal); the
            inner content is what unfolds. enterAtFrame is set before f0 so the
            island's own entrance is complete at scene start. */}
        <TerminalIsland
          header="wbhk listen"
          width={islandWidth}
          raised={false}
          enterAtFrame={-motion.railsDurationFrames}
        >
          <div
            style={{
              position: "relative",
              transformOrigin: "top",
              transform: `scaleY(${unfold})`,
              opacity: unfold,
            }}
          >
            {/* Header block — keys dim, values fg. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 * s }}>
              {HEADERS.map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    gap: 24 * s,
                    fontFamily: mono,
                    fontSize: bodyFont,
                    lineHeight: 1.5,
                  }}
                >
                  <span style={{ color: colors.termDim, width: 320 * s }}>{k}</span>
                  <span style={{ color: colors.termFg }}>{v}</span>
                </div>
              ))}
            </div>

            {/* JSON body panel — raised term-bg-2 to contrast the header block. */}
            <div
              style={{
                marginTop: 24 * s,
                background: colors.termBg2,
                border: `1px solid ${colors.termBorder}`,
                borderRadius: radii.terminal,
                padding: 24 * s,
                fontFamily: mono,
                fontSize: bodyFont,
                lineHeight: 1.5,
                color: colors.termFg,
                whiteSpace: "pre",
              }}
            >
              {BODY_LINES.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>

            {/* Single faint scanline sweep — "captured whole". */}
            {frame >= 20 && frame <= 50 ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${sweep}%`,
                  height: 3,
                  background: `linear-gradient(90deg, transparent, ${colors.wire}, transparent)`,
                  boxShadow: `0 0 12px ${colors.verifiedGlow}`,
                  pointerEvents: "none",
                }}
              />
            ) : null}
          </div>
        </TerminalIsland>

        {/* Micro-caption (Inter, dim) fades in from f330. */}
        <div style={{ color: colors.termDim }}>
          <KineticLine
            text={CAPTION}
            startFrame={30}
            size={type.caption.fontSize * s}
            weight={type.caption.fontWeight}
            align="center"
          />
        </div>
      </div>
    </AbsoluteFill>
  );
}
