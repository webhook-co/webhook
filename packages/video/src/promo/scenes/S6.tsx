// S6 · frames 360–450 · 0:12–0:15 — hard cut to the light dashboard (brief §5 S6).
//
// ACT II's light theme opens. A HARD CUT from S5's dark terminal to the
// off-white dashboard at app.webhook.co/events: the SAME event that landed in
// the terminal (linear · verified · 0197f0c1-…) reappears on a <DashboardCard>,
// so the event "travels surface→surface". The whole light panel wipes in from
// the terminal's last (center) position across local f0–21 (comp f360–381),
// eased on rails (§3.4, no bounce). A provider counter rolls 0→142, fast then
// eased, local f40–70 (comp f400–430); the kinetic line "Verified at the edge.
// 142 providers." settles in dark ink beneath. 142 is the film's only real
// number (brief §1). Authored in scene-local frames.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { CAPTIONS } from "../captions";
import { DashboardCard } from "../components/DashboardCard";
import { DotsBackground } from "../components/DotsBackground";
import { KineticLine } from "../components/KineticLine";
import { inter, mono } from "../fonts";
import { colors, motion, titleSafe, type, verticalScale } from "../tokens";
import type { Format } from "../tokens";

interface S6Props {
  format: Format;
}

const URL_TEXT = CAPTIONS.find((c) => c.scene === "S6" && c.kind === "url")?.text ?? "";
const HERO_TEXT = CAPTIONS.find((c) => c.scene === "S6" && c.kind === "hero")?.text ?? "";

// The same event as the terminal side (S3/S4), byte-for-byte.
const EVENT = {
  provider: "linear",
  received: "2026-07-12T14:02:11.840Z",
  id: "0197f0c1-...",
  state: "verified",
} as const;

// The one real number in the film (brief §1). The counter rolls 0 → this.
const PROVIDER_COUNT = 142;
const COUNT_START = 40; // local f40 (comp f400)
const COUNT_END = 70; // local f70 (comp f430)

const EASE_OUT_CUBIC = Easing.out(Easing.cubic);
const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

export function S6({ format }: S6Props) {
  const frame = useCurrentFrame();
  const { width: W } = useVideoConfig();
  const s = format === "9x16" ? verticalScale : 1;
  const m = titleSafe[format];

  // The whole dashboard group wipes in from the terminal's last position — the
  // event travels surface→surface (brief §5 S6), on rails, no bounce.
  const wipe = interpolate(frame, [0, motion.railsDurationFrames], [0, 1], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const wipeShift = interpolate(wipe, [0, 1], [-64 * s, 0]);

  // Provider counter rolls 0→142, fast then eased (brief §5 S6).
  const count =
    frame < COUNT_START
      ? 0
      : Math.round(
          interpolate(frame, [COUNT_START, COUNT_END], [0, PROVIDER_COUNT], {
            easing: EASE_OUT_CUBIC,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        );

  const chromeWidth = Math.min(560 * s, W - 2 * m);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <DotsBackground theme="light" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 44 * s,
          opacity: wipe,
          transform: `translateX(${wipeShift}px)`,
        }}
      >
        {/* URL chrome — light browser bar showing the events route. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14 * s,
            width: chromeWidth,
            padding: `${12 * s}px ${20 * s}px`,
            borderRadius: 999,
            background: colors.pagePanel,
            border: `1px solid ${colors.pageBorder}`,
          }}
        >
          <span style={{ display: "flex", gap: 7 * s }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 9 * s,
                  height: 9 * s,
                  borderRadius: "50%",
                  background: colors.pageBorder,
                }}
              />
            ))}
          </span>
          <span
            style={{
              fontFamily: mono,
              fontSize: type.badge.fontSize * s,
              color: colors.pageDim,
            }}
          >
            {URL_TEXT}
          </span>
        </div>

        {/* The same event on the light card + the rolling provider counter. */}
        <div style={{ display: "flex", alignItems: "center", gap: 72 * s }}>
          <DashboardCard
            provider={EVENT.provider}
            received={EVENT.received}
            id={EVENT.id}
            state={EVENT.state}
            startFrame={0}
          />

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span
              style={{
                fontFamily: inter,
                fontSize: 96 * s,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                lineHeight: 1,
                color: colors.pageInk,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {count}
            </span>
            <span
              style={{
                fontFamily: inter,
                fontSize: type.trustFooter.fontSize * s,
                color: colors.pageDim,
                marginTop: 6 * s,
              }}
            >
              providers
            </span>
          </div>
        </div>

        {/* "Verified at the edge. 142 providers." — dark ink on the light page. */}
        <div style={{ color: colors.pageInk }}>
          <KineticLine
            text={HERO_TEXT}
            startFrame={40}
            size={type.caption.fontSize * s * 1.2}
            weight={600}
            align="center"
          />
        </div>
      </div>
    </AbsoluteFill>
  );
}
