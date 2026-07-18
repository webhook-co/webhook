// S17 · frames 1470–1560 · 0:49–0:52 — scoped read vs reroute (brief §5 S17).
//
// Three beats on the dark frame. (1) The woken agent emits an action — a small
// green success tick that pops in (local f2). (2) Below it, a second, FORGED
// event tries the same path and is STOPPED at the verify gate: it decelerates
// and DISSOLVES before the agent node (local f0→f30) — the rejection reads
// entirely through MOTION, never a color (Act III accent rule: green only, no
// red/amber). A small "forged event — never surfaced" label fades in as it
// dies. (3) Two capability lines resolve (local f35→f80): "can read the event."
// (green check) and "can't reroute delivery." — a lock snaps shut over the word
// "reroute" at local f50 (comp f1520, the brief's lock-click beat).
//
// Strings are the real caption copy (brief §6.1), byte-for-byte. Authored in
// scene-local frames.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { badgeGlowOpacity, badgePopScale } from "../components/VerifiedBadge";
import { inter, mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S17Props {
  format: Format;
}

const REJECT_LABEL = CAPTIONS.find((c) => c.scene === "S17" && c.kind === "reject")?.text ?? "";
const CAP2 = CAPTIONS.find((c) => c.scene === "S17" && c.kind === "cap2")?.text ?? "";
const [CAP_READ = "", CAP_REROUTE = ""] = CAP2.split(" / ");

const EASE_OUT_CUBIC = Easing.out(Easing.cubic);

const TICK_POP = 2; // the action tick pops local f2
const FORGED_TRAVEL = 28; // decelerates toward the gate over local f0→f28
const READ_START = 35; // "can read the event." resolves
const REROUTE_START = 42; // "can't reroute delivery." resolves
const LOCK_SNAP = 50; // the lock snaps shut over "reroute" (comp f1520)

// Split "can't reroute delivery." so the lock can sit over the "reroute" word.
const REROUTE_WORD = "reroute";
const [REROUTE_PRE = "", REROUTE_POST = ""] = CAP_REROUTE.split(REROUTE_WORD);

export function S17({ format }: S17Props) {
  const frame = useCurrentFrame();
  const { width: W, fps } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];
  const avail = W - 2 * m;

  // (1) The agent action tick — pops in green.
  const tickVisible = frame >= TICK_POP;
  const tickScale = tickVisible ? badgePopScale(frame - TICK_POP, fps) : 1;
  const tickGlow = tickVisible ? badgeGlowOpacity(frame - TICK_POP) : 0;

  // (2) The forged event — decelerates toward the gate, then dissolves (reads via
  // motion only). Track: origin → verify gate → agent (unreached).
  const trackW = Math.min(avail * 0.52, 720);
  const gateX = trackW * 0.62;
  const forgedTravel = interpolate(frame, [0, FORGED_TRAVEL], [0, 1], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const forgedX = forgedTravel * gateX;
  const forgedOpacity = interpolate(frame, [16, FORGED_TRAVEL + 2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rejectOpacity = interpolate(frame, [16, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // (3) Capability lines — settle in; the lock snaps shut on "reroute".
  const readSettle = interpolate(frame, [READ_START, READ_START + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rerouteSettle = interpolate(frame, [REROUTE_START, REROUTE_START + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lockVisible = frame >= LOCK_SNAP - 6;
  const lockShut = interpolate(frame, [LOCK_SNAP - 6, LOCK_SNAP], [0, 1], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lockScale = frame >= LOCK_SNAP ? badgePopScale(frame - LOCK_SNAP, fps) : 1;

  const capFont = type.caption.fontSize * s;

  // A small drawn lock (neutral — no alert color). Shackle drops into the body as
  // it snaps shut; `shut` 0→1 seats the shackle.
  const lock = (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top: -34 * s,
        transform: `translateX(-50%) scale(${lockScale})`,
        display: lockVisible ? "flex" : "none",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <span
        style={{
          width: 20 * s,
          height: 16 * s,
          border: `3px solid ${colors.termFg}`,
          borderBottom: "none",
          borderTopLeftRadius: 10 * s,
          borderTopRightRadius: 10 * s,
          transform: `translateY(${interpolate(lockShut, [0, 1], [6 * s, 2 * s])}px)`,
          marginBottom: -2 * s,
        }}
      />
      <span
        style={{
          width: 30 * s,
          height: 22 * s,
          borderRadius: 5 * s,
          background: colors.termFg,
        }}
      />
    </span>
  );

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 52 * s,
        }}
      >
        {/* (1) The agent emits an action — a small green success tick. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 * s, height: 48 * s }}>
          {tickVisible ? (
            <>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 40 * s,
                  height: 40 * s,
                  borderRadius: "50%",
                  border: `2px solid ${colors.verified}`,
                  color: colors.verified,
                  fontFamily: inter,
                  fontSize: 24 * s,
                  fontWeight: 600,
                  transform: `scale(${tickScale})`,
                  boxShadow:
                    tickGlow > 0
                      ? `0 0 ${Math.round(20 * tickGlow)}px ${colors.verifiedGlow}`
                      : "none",
                }}
              >
                ✓
              </span>
              <span
                style={{
                  ...type.badge,
                  fontSize: type.badge.fontSize * s,
                  fontFamily: mono,
                  color: colors.verified,
                }}
              >
                action
              </span>
            </>
          ) : null}
        </div>

        {/* (2) The forged event — decelerates into the verify gate and dissolves. */}
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 * s }}
        >
          <div style={{ position: "relative", width: trackW, height: 56 * s }}>
            {/* Track hairline. */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: "50%",
                width: trackW,
                height: 2,
                background: colors.termBorder,
                transform: "translateY(-50%)",
              }}
            />
            {/* Verify gate marker. */}
            <div
              style={{
                position: "absolute",
                left: gateX,
                top: "50%",
                transform: "translate(-50%, -50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6 * s,
              }}
            >
              <div style={{ width: 3, height: 34 * s, background: colors.termDim }} />
            </div>
            <span
              style={{
                position: "absolute",
                left: gateX,
                top: "50%",
                transform: `translate(-50%, ${28 * s}px)`,
                fontFamily: mono,
                fontSize: type.trustFooter.fontSize * s,
                color: colors.termDim,
              }}
            >
              verify
            </span>
            {/* Agent marker (dim, unreached). */}
            <span
              style={{
                position: "absolute",
                left: trackW,
                top: "50%",
                transform: `translate(-100%, -50%)`,
                fontFamily: mono,
                fontSize: type.trustFooter.fontSize * s,
                color: colors.termDim,
                opacity: 0.6,
              }}
            >
              agent
            </span>
            {/* The forged capsule — decelerates, then dissolves at the gate. */}
            <div
              style={{
                position: "absolute",
                left: forgedX,
                top: "50%",
                transform: "translate(-50%, -50%)",
                display: "inline-flex",
                alignItems: "center",
                gap: 8 * s,
                padding: `${6 * s}px ${14 * s}px`,
                borderRadius: 999,
                border: `1px solid ${colors.termBorder}`,
                background: colors.termBg2,
                opacity: forgedOpacity,
              }}
            >
              <span
                style={{
                  width: 7 * s,
                  height: 7 * s,
                  borderRadius: "50%",
                  background: colors.termDim,
                }}
              />
              <span
                style={{
                  fontFamily: mono,
                  fontSize: type.trustFooter.fontSize * s,
                  color: colors.termDim,
                }}
              >
                forged
              </span>
            </div>
          </div>
          {/* "forged event — never surfaced" — neutral, small (motion carries it). */}
          <span
            style={{
              fontFamily: inter,
              fontSize: type.trustFooter.fontSize * s,
              color: colors.termDim,
              opacity: rejectOpacity,
            }}
          >
            {REJECT_LABEL}
          </span>
        </div>

        {/* (3) Two capability lines: scoped read (green) vs no reroute (lock). */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 28 * s,
          }}
        >
          {/* can read the event. — green check. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16 * s,
              opacity: readSettle,
              transform: `translateY(${interpolate(readSettle, [0, 1], [10 * s, 0])}px)`,
            }}
          >
            <span
              style={{
                color: colors.verified,
                fontFamily: inter,
                fontSize: capFont,
                fontWeight: 600,
              }}
            >
              ✓
            </span>
            <span style={{ fontFamily: inter, fontSize: capFont, color: colors.termFg }}>
              {CAP_READ}
            </span>
          </div>

          {/* can't reroute delivery. — a lock snaps shut over "reroute". */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16 * s,
              opacity: rerouteSettle,
              transform: `translateY(${interpolate(rerouteSettle, [0, 1], [10 * s, 0])}px)`,
            }}
          >
            {/* Icon slot kept for row alignment — the closed lock lives over the word. */}
            <span style={{ width: capFont * 0.7, display: "inline-block" }} />
            <span style={{ fontFamily: inter, fontSize: capFont, color: colors.termDim }}>
              {REROUTE_PRE}
              <span style={{ position: "relative", color: colors.termFg }}>
                {REROUTE_WORD}
                {lock}
              </span>
              {REROUTE_POST}
            </span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}
