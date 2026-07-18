// Wordmark — the "webhook.co" typographic lockup (brief §4.14 / §5 S19–S20).
//
// Brief inventory item 14: `{ startFrame }`. `webhook.co` typeset (NOT an
// image) — lowercase, Inter, with the film's single `colors.verified` accent
// carried by the "." (the lockup's one accent underscore). Act IV runs on the
// light page (brief S18: "the one green accent carries as the sole color"), so
// the mark itself is `colors.pageInk` with only the "." in `colors.verified`.
// Settles via the exact §3.4 headline-settle spring — translateY(12→0) +
// opacity(0→1), no bounce — the identical config KineticLine/IngestPill use.
//
// Split into a pure `WordmarkView` (plain `progress` prop, no Remotion hooks —
// renders like any other React component in jsdom) and the `Wordmark` wrapper
// that owns `useCurrentFrame()`/`useVideoConfig()`, mirroring the existing
// KineticLine/TypedLine adapter split in this package.

import type { CSSProperties, ReactElement } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { inter } from "../fonts";
import { colors, springs } from "../tokens";

// A mid-scale default (S19's signature-line companion). S20's small end-card
// mark passes a smaller `size` — the lockup itself never changes, only scale.
const DEFAULT_SIZE = 56;

export interface WordmarkViewProps {
  /** Settle-spring progress in [0, 1] — a plain number, no Remotion hooks. */
  progress: number;
  /** Font size in px. Defaults to the S19 mid-scale lockup. */
  size?: number;
}

/**
 * Pure presentational half: derives opacity/translateY from `progress` via
 * `interpolate()` (a pure function, safe outside a Remotion composition
 * context), so it renders exactly like any other React component and is
 * trivially unit-testable in jsdom. The lockup text never varies — "webhook"
 * + a `colors.verified` "." + "co" — lowercase, Inter, the brief's brand-name
 * rule honored byte-for-byte.
 */
export function WordmarkView({ progress, size = DEFAULT_SIZE }: WordmarkViewProps): ReactElement {
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
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: colors.pageInk,
    opacity,
    transform: `translateY(${translateY}px)`,
  };

  return (
    <div style={style}>
      webhook
      <span style={{ color: colors.verified }}>.</span>
      co
    </div>
  );
}

export interface WordmarkProps {
  /** Absolute frame the settle spring begins on. */
  startFrame: number;
  /** Font size in px. Defaults to the S19 mid-scale lockup; S20 passes smaller. */
  size?: number;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`/`useVideoConfig()`, computes
 * the headline-settle spring (brief §3.4, no bounce — identical config to
 * KineticLine/IngestPill), and hands a plain `progress` number down to
 * `WordmarkView`.
 */
export function Wordmark({ startFrame, size }: WordmarkProps): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    fps,
    frame: frame - startFrame,
    config: springs.headlineSettle,
  });

  return <WordmarkView progress={progress} size={size} />;
}
