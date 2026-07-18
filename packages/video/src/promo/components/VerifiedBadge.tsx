// VerifiedBadge — colored dot + lowercase label for a webhook's verification
// state (brief §3.1 / §4.4).
//
// `state` drives the dot color: `verified` → the film's one saturated accent
// (`--verified`, green); `authenticated` → amber; `failed` → the brief's
// sparingly-used red; `unattempted` → grey. `pop` layers the exact §3.4
// overshoot spring (`scale(1.06→1.0)`) on top of the base entrance fade, plus a
// decaying `--verified-glow` — but ONLY when `state === "verified"`, since
// green is the film's only saturated non-alert accent (brief §3.1 "accent
// discipline": the glow never fires for authenticated/failed/unattempted).
//
// Split into pure logic (`stateColor`, `badgePopScale`, `badgeGlowOpacity`,
// `badgeFadeInOpacity`) + a hook-free `VerifiedBadgeView` + a thin
// `VerifiedBadge` wrapper that owns `useCurrentFrame()`/`useVideoConfig()` —
// the same adapter split already used by `TypedLine`/`TerminalIsland` in this
// package. `EventRow` reuses the pure helpers + `VerifiedBadgeView` directly
// (see EventRow.tsx) so its own View half stays hook-free too.

import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { mono } from "../fonts";
import { colors, motion, springs, type } from "../tokens";

/** The four verification states a webhook event can land in (brief §3.1 / §4.4). */
export type VerifiedState = "verified" | "authenticated" | "failed" | "unattempted";

const EASE_OUT_CUBIC = Easing.out(Easing.cubic);

/** Pure state → token-color mapping (brief §3.1). The real logic under test. */
export function stateColor(state: VerifiedState): string {
  switch (state) {
    case "verified":
      return colors.verified;
    case "authenticated":
      return colors.authenticated;
    case "failed":
      return colors.failed;
    case "unattempted":
      return colors.unattempted;
  }
}

/**
 * The base entrance: a quick 10-frame fade-in from `relativeFrame` 0 (the S9
 * legend's "lights 0→100% as its label lands" beat). A pure function of
 * `interpolate` — no Remotion hooks — so it's directly unit-testable.
 */
export function badgeFadeInOpacity(relativeFrame: number): number {
  return interpolate(relativeFrame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * The §3.4 overshoot spring — `scale(1.06→1.0)` — as a pure function of
 * `relativeFrame`/`fps` (Remotion's `spring()` takes `fps` as an explicit
 * argument, so this needs no hooks and is directly unit-testable). Reused by
 * `EventRow` for its composed badge, so both components use the identical
 * "pop" motion.
 */
export function badgePopScale(relativeFrame: number, fps: number): number {
  return spring({ frame: relativeFrame, fps, config: springs.land, from: 1.06, to: 1 });
}

/**
 * `--verified-glow` intensity, 0→1, decaying over `motion.ringPulse`'s 24-frame
 * duration with the brief's `Easing.out(Easing.cubic)` — reusing the ring-pulse
 * timing constant for visual consistency with the RingPulse land beat it
 * accompanies. Callers gate this to `state === "verified"` themselves.
 */
export function badgeGlowOpacity(relativeFrame: number): number {
  return interpolate(relativeFrame, [0, motion.ringPulse.durationFrames], [1, 0], {
    easing: EASE_OUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

const DOT_SIZE = 10;
const MAX_GLOW_BLUR = 24;

export interface VerifiedBadgeViewProps {
  state: VerifiedState;
  /** Entrance opacity, 0→1. A plain number — no Remotion hooks. */
  opacity: number;
  /** Dot+label scale — 1 at rest, or the §3.4 overshoot curve while popping. */
  scale: number;
  /** `--verified-glow` intensity, 0→1. Always 0 unless popping AND `state === "verified"`. */
  glowOpacity: number;
}

/**
 * Pure presentational half: takes the already-computed motion as plain props
 * (no `useCurrentFrame()`), so it renders like any other React component and
 * is trivially unit-testable in jsdom. Composed directly by `EventRow`'s own
 * pure View, too.
 */
export function VerifiedBadgeView({ state, opacity, scale, glowOpacity }: VerifiedBadgeViewProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <span
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: "50%",
          backgroundColor: stateColor(state),
          boxShadow:
            glowOpacity > 0
              ? `0 0 ${Math.round(MAX_GLOW_BLUR * glowOpacity)}px ${colors.verifiedGlow}`
              : "none",
        }}
      />
      <span style={{ ...type.badge, fontFamily: mono, color: "currentColor" }}>{state}</span>
    </div>
  );
}

export interface VerifiedBadgeProps {
  state: VerifiedState;
  /** Absolute frame the badge begins its entrance. */
  startFrame: number;
  /** Triggers the overshoot pop + (verified-only) `--verified-glow`. Defaults to `false`. */
  pop?: boolean;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`/`useVideoConfig()`, computes
 * the entrance fade and (when `pop`) the overshoot scale + glow via the pure
 * helpers above, and hands plain numbers down to `VerifiedBadgeView`.
 */
export function VerifiedBadge({ state, startFrame, pop = false }: VerifiedBadgeProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const relativeFrame = frame - startFrame;

  const opacity = badgeFadeInOpacity(relativeFrame);
  const scale = pop ? badgePopScale(relativeFrame, fps) : 1;
  const glowOpacity = pop && state === "verified" ? badgeGlowOpacity(relativeFrame) : 0;

  return (
    <VerifiedBadgeView state={state} opacity={opacity} scale={scale} glowOpacity={glowOpacity} />
  );
}
