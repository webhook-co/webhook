// S13 · frames 1020–1110 · 0:34–0:37 — the turn (brief §5 S13).
//
// A near-empty dark frame. One line resolves: "Then hand your agents an event
// they can act on." (the real hero subhead, byte-for-byte) — the <KineticLine>
// settle from local f4 (comp f1024, brief's mask-reveal window f1024→f1050).
// Then a faint event capsule (the same 0197f0c1-… event, carried over from the
// last surface in S12) drifts in on rails and holds, WAITING — the visual setup
// for the agent that will consume it in S14–S16.
//
// Accent discipline (Act III): green only, and here the frame is nearly bare —
// the capsule is deliberately faint (dim, low opacity), not yet verified-green;
// the event is "waiting", not landing. Authored in scene-local frames.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { mono } from "../fonts";
import { colors, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S13Props {
  format: Format;
}

const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S13" && c.kind === "hero")?.text ?? "";
const SHARED_ID = "0197f0c1-..."; // the same event, carried in from S12

const HERO_START = 4; // comp f1024
const CAPSULE_START = 30; // drifts in after the line has resolved
const CAPSULE_DRIFT = 30; // eased on rails
const CAPSULE_REST_OPACITY = 0.4; // faint — it is waiting, not landing

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

export function S13({ format }: S13Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // The capsule drifts in from the right on rails and settles faint.
  const drift = interpolate(frame, [CAPSULE_START, CAPSULE_START + CAPSULE_DRIFT], [0, 1], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const capsuleShift = interpolate(drift, [0, 1], [80 * s, 0]);
  const capsuleOpacity = interpolate(drift, [0, 1], [0, CAPSULE_REST_OPACITY]);

  const heroSize = Math.min(type.hero.fontSize * s, (W - 2 * m) / 11);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="dark" />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 64 * s,
          color: colors.termFg,
          maxWidth: W - 2 * m,
        }}
      >
        <KineticLine
          text={HERO_TEXT}
          startFrame={HERO_START}
          size={heroSize}
          weight={600}
          align="center"
        />

        {/* The faint, waiting event capsule — the same event, carried in. */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12 * s,
            padding: `${12 * s}px ${22 * s}px`,
            borderRadius: 999,
            border: `1px solid ${colors.termBorder}`,
            background: colors.termBg2,
            opacity: capsuleOpacity,
            transform: `translateX(${capsuleShift}px)`,
          }}
        >
          <span
            style={{
              width: 8 * s,
              height: 8 * s,
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
            {SHARED_ID}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
