// KineticLine — Inter kinetic headline with the brief's "no-bounce" settle spring.
//
// Brief §4.5: `{ text; startFrame; size; weight; align }`. Drives
// `translateY(12px→0)` + `opacity(0→1)` off `springs.headlineSettle` (brief
// §3.4's exact `{ damping: 200, stiffness: 120, mass: 0.6 }` — heavily
// overdamped, so it settles with no overshoot/bounce). Big lines (over the
// caption type-scale size) get the tight `-0.02em` tracking brief §3.2 bakes
// into `type.hero`; smaller Inter roles (caption/badge/trust footer) keep
// normal tracking.
//
// Split into a pure `KineticLineView` (plain `progress` prop, no Remotion
// hooks — renders like any other React component in jsdom) and the
// `KineticLine` wrapper that owns `useCurrentFrame()`/`useVideoConfig()`,
// mirroring the existing HeadlineScene/BrandLockup adapter split in this
// package.

import type { CSSProperties, ReactElement } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { inter } from "../fonts";
import { springs, type } from "../tokens";

export type KineticLineAlign = "left" | "center" | "right";

export interface KineticLineProps {
  /** The real headline/caption string to reveal (rendered byte-for-byte). */
  text: string;
  /** Absolute frame the settle spring begins on. */
  startFrame: number;
  /** Font size in px (brief §3.2 type scale — e.g. 84 for the hero line). */
  size: number;
  /** Font weight — 600 for headlines, 400 for captions (brief §3.2). */
  weight: number;
  /** CSS text-align for the line. */
  align: KineticLineAlign;
}

/**
 * Above this size a line counts as a "big line" (brief §3.2) and gets the
 * tight `-0.02em` tracking `type.hero` bakes in; at/under caption size (40px)
 * tracking stays normal — matching the roles `tokens.ts` itself distinguishes
 * (only `type.hero` carries `letterSpacing`).
 */
const BIG_LINE_THRESHOLD = type.caption.fontSize;

export interface KineticLineViewProps {
  text: string;
  size: number;
  weight: number;
  align: KineticLineAlign;
  /** Settle-spring progress in [0, 1] — a plain number, no Remotion hooks. */
  progress: number;
}

/**
 * Pure presentational half: derives `opacity`/`translateY` from `progress`
 * via `interpolate()` (a pure function, safe outside a Remotion composition
 * context), so it renders exactly like any other React component and is
 * trivially unit-testable in jsdom.
 */
export function KineticLineView({
  text,
  size,
  weight,
  align,
  progress,
}: KineticLineViewProps): ReactElement {
  const opacity = interpolate(progress, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(progress, [0, 1], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const style: CSSProperties = {
    fontFamily: inter,
    fontSize: size,
    fontWeight: weight,
    textAlign: align,
    letterSpacing: size > BIG_LINE_THRESHOLD ? "-0.02em" : "normal",
    opacity,
    transform: `translateY(${translateY}px)`,
  };

  return <div style={style}>{text}</div>;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`/`useVideoConfig()`, computes
 * the headline-settle spring (brief §3.4, no bounce), and hands a plain
 * `progress` number down to `KineticLineView`.
 */
export function KineticLine({
  text,
  startFrame,
  size,
  weight,
  align,
}: KineticLineProps): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    fps,
    frame: frame - startFrame,
    config: springs.headlineSettle,
  });

  return (
    <KineticLineView text={text} size={size} weight={weight} align={align} progress={progress} />
  );
}
