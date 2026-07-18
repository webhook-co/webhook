// S16 · frames 1350–1470 · 0:45–0:49 · ★ MONEY FRAME #3 — the wake (brief §5 S16).
//
// A split: left, the <FlowDiagram nodes={['event','verified','agent','action']}>;
// right, the parked agent block. The upstream nodes light in sequence (local
// f0→f50); the green `verified` token physically travels the connector into the
// `agent` node (local f50→f80); at the wake (local f80, comp f1430 — the film's
// biggest release) the parked block FILLS green and springs to life (the §3.4
// overshoot, reusing the film's one shared land motion), its status pill snaps
// waiting → woke, a RingPulse radiates, and the `triggers.wait` return payload
// prints just after (local f85, comp f1435). The whole beat then HOLDS to local
// f120 (comp f1470) — the export still.
//
// FlowDiagram owns the node-light + token-travel clock (from its own
// `startFrame`); this scene reads the exported `flowWakeFrame` /
// `flowReturnPayloadFrame` to synchronise the right block, the RingPulse, and
// the payload to the exact same wake. Accent discipline (Act III): green is the
// only saturated accent — the token, the woken agent, the verified payload; the
// parked/waiting state is neutral. Authored in scene-local frames.

import {
  AbsoluteFill,
  interpolate,
  interpolateColors,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { DotsBackground } from "../components/DotsBackground";
import {
  FLOW_NODES_DEFAULT,
  FlowDiagram,
  flowReturnPayloadFrame,
  flowWakeFrame,
  AGENT_FILL_RAMP,
} from "../components/FlowDiagram";
import { RingPulse } from "../components/RingPulse";
import { badgeGlowOpacity, badgePopScale } from "../components/VerifiedBadge";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S16Props {
  format: Format;
}

const FLOW_START = 0; // node-light sequence begins at scene start (comp f1350)
const WAKE = flowWakeFrame(FLOW_START); // local f80 (comp f1430)
const RETURN_PAYLOAD = flowReturnPayloadFrame(FLOW_START); // local f85 (comp f1435)

// The returned event — the same event, verified (brief §5 S16: "triggers.wait
// returns the event"). Real fields, byte-for-byte.
const EVENT = { provider: "linear", state: "verified", id: "0197f0c1-..." } as const;

export function S16({ format }: S16Props) {
  const frame = useCurrentFrame();
  const { width: W, fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];
  const isV = format === "9x16";
  const avail = W - 2 * m;

  const flowW = isV ? Math.min(avail, 820) : Math.min(avail * 0.55, 900);
  const flowH = flowW / 3;
  const RW = isV ? Math.min(avail * 0.86, 720) : Math.min(avail * 0.34, 520);

  // The right parked block wakes in lockstep with the FlowDiagram's agent node.
  const woke = frame >= WAKE;
  const wokeRel = frame - WAKE;
  const fill = interpolate(frame, [WAKE, WAKE + AGENT_FILL_RAMP], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blockScale = woke ? badgePopScale(wokeRel, fps) : 1;
  const glow = woke ? badgeGlowOpacity(wokeRel) : 0;
  const blockBorder = interpolateColors(fill, [0, 1], [colors.termBorder, colors.verified]);

  // Before the wake the pill breathes (still parked, carrying the S15 tone);
  // at the wake it snaps to "woke" and the whole block springs.
  const breathe = 0.7 + 0.3 * Math.cos((2 * Math.PI * frame) / 40);
  const pillOpacity = woke ? 1 : breathe;
  const pillColor = woke ? colors.verified : colors.termFg;
  const pillDot = woke ? colors.verified : colors.termDim;

  // The return payload prints just after the wake (a quick fade-in "print").
  const payloadOpacity = interpolate(frame, [RETURN_PAYLOAD, RETURN_PAYLOAD + 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Payload font sized so the full "linear  verified  0197f0c1-..." line fits
  // inside the block's padded width without clipping the id.
  const bodyFont = 24 * s;
  const rightBlock = (
    <div
      style={{
        position: "relative",
        width: RW,
        display: "flex",
        flexDirection: "column",
        gap: 20 * s,
        padding: `${28 * s}px ${28 * s}px`,
        borderRadius: 14,
        border: `1.5px solid ${blockBorder}`,
        background: colors.termBg2,
        boxShadow: glow > 0 ? `0 0 ${Math.round(28 * glow)}px ${colors.verifiedGlow}` : "none",
        transform: `scale(${blockScale})`,
      }}
    >
      {/* Translucent verified wash — the fill (grows 0→ as the block wakes). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 14,
          background: colors.verified,
          opacity: fill * 0.12,
          pointerEvents: "none",
        }}
      />

      {/* Header — the agent surface. */}
      <span
        style={{
          ...type.badge,
          fontSize: type.badge.fontSize * s,
          fontFamily: mono,
          color: colors.termDim,
          position: "relative",
        }}
      >
        agent
      </span>

      {/* Status pill — snaps waiting → woke at the wake. */}
      <div
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 12 * s,
          padding: `${8 * s}px ${16 * s}px`,
          borderRadius: 999,
          border: `1px solid ${colors.termBorder}`,
          background: colors.termBg,
          opacity: pillOpacity,
          alignSelf: "flex-start",
        }}
      >
        <span
          style={{
            width: 9 * s,
            height: 9 * s,
            borderRadius: "50%",
            background: pillDot,
            boxShadow:
              woke && glow > 0 ? `0 0 ${Math.round(14 * glow)}px ${colors.verifiedGlow}` : "none",
          }}
        />
        <span style={{ fontFamily: mono, fontSize: type.badge.fontSize * s, color: pillColor }}>
          {woke ? "woke" : "waiting"}
        </span>
      </div>

      {/* The triggers.wait return payload — prints just after the wake. */}
      <div
        style={{
          position: "relative",
          fontFamily: mono,
          fontSize: bodyFont,
          whiteSpace: "pre",
          opacity: payloadOpacity,
        }}
      >
        <span style={{ color: colors.termDim }}>{EVENT.provider}</span>
        <span style={{ color: colors.termDim }}>{"  "}</span>
        <span style={{ color: colors.verified, fontWeight: 600 }}>{EVENT.state}</span>
        <span style={{ color: colors.termDim }}>{"  "}</span>
        <span style={{ color: colors.termDim }}>{EVENT.id}</span>
      </div>

      {/* The wake radiate — fires on the parked agent as it springs to life
          (block-local coords: RingPulse fills this position:relative block). */}
      <RingPulse atXY={{ x: RW / 2, y: 110 * s }} startFrame={WAKE} size={RW * 0.85} />
    </div>
  );

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: isV ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: (isV ? 56 : 72) * s,
        }}
      >
        <FlowDiagram
          nodes={FLOW_NODES_DEFAULT}
          startFrame={FLOW_START}
          width={flowW}
          height={flowH}
        />
        {rightBlock}
      </div>
    </AbsoluteFill>
  );
}
