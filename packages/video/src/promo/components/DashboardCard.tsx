// DashboardCard — the light-mode event card at app.webhook.co/events (brief §4.9).
//
// Act II's first light-theme surface: the same event that landed in the dark
// terminal (S1–S5) reappears here on `--page-bg`'s white card surface
// (`--page-panel`), `--page-border` hairline, `--page-ink`/`--page-dim` text —
// carrying the event's `provider`, `received` timestamp, `id` (already
// truncated by the caller, mirroring `EventRow`'s `id` convention — see
// `EVENTS_TABLE`'s `0197f0c1-...` form), and its `<VerifiedBadge>` state.
//
// Land is the exact §3.4 overshoot spring (`scale(1.06→1.0)`) driven by
// `springs.land` from `startFrame` — the card snaps into place the same way
// `EventRow` does on the terminal side, so the "same event, every surface"
// motif (brief §1.3) reads as one consistent motion language, not two. The
// composed badge pops + glows (verified-only) in lockstep with the card's own
// land, reusing `VerifiedBadge`'s exported pure helpers exactly as `EventRow`
// does.
//
// Split into a hook-free `DashboardCardView` (composes `VerifiedBadgeView`
// directly, not the hook-wrapping `VerifiedBadge`, so it stays fully testable
// in jsdom with no Remotion composition context) + a thin `DashboardCard`
// wrapper that owns `useCurrentFrame()`/`useVideoConfig()` — the same adapter
// split used by `EventRow`/`VerifiedBadge`/`TerminalIsland` in this package.
//
// The brief asks for a "subtle card shadow" but the shared `shadows` token
// only defines the terminal island's dark, heavy float (`shadows.terminal`,
// tuned for a near-black panel). A light white-on-off-white card needs a much
// quieter elevation, so `CARD_SHADOW` is defined locally here rather than
// stretched from a shadow tuned for the opposite theme.

import { spring, useCurrentFrame, useVideoConfig } from "remotion";

import { mono } from "../fonts";
import { colors, radii, springs, type } from "../tokens";
import {
  badgeGlowOpacity,
  badgePopScale,
  type VerifiedBadgeViewProps,
  VerifiedBadgeView,
  type VerifiedState,
} from "./VerifiedBadge";

const CARD_PADDING = 28;
/** A quiet elevation for a white card on the off-white page — no token defines
 * a light-surface shadow (see file header), so this is tuned locally. */
const CARD_SHADOW = "0 1px 2px rgba(11,13,16,0.04), 0 12px 32px rgba(11,13,16,0.08)";

export interface DashboardCardViewProps {
  provider: string;
  received: string;
  id: string;
  state: VerifiedState;
  /** Card land scale, 1.06→1.0 as it snaps into place. A plain number — no Remotion hooks. */
  scale: number;
  /** The composed badge's own opacity/scale/glow — already computed by the wrapper. */
  badgeMotion: Pick<VerifiedBadgeViewProps, "opacity" | "scale" | "glowOpacity">;
}

/**
 * Pure presentational half: takes the already-computed card scale + composed
 * badge motion as plain props (no `useCurrentFrame()`), so it renders like any
 * other React component and is trivially unit-testable in jsdom.
 */
export function DashboardCardView({
  provider,
  received,
  id,
  state,
  scale,
  badgeMotion,
}: DashboardCardViewProps) {
  return (
    <div
      data-testid="dashboard-card"
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 16,
        padding: CARD_PADDING,
        borderRadius: radii.terminal,
        border: `1px solid ${colors.pageBorder}`,
        backgroundColor: colors.pagePanel,
        boxShadow: CARD_SHADOW,
        color: colors.pageInk,
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
        }}
      >
        <span
          data-testid="dashboard-card-provider"
          style={{ ...type.terminalBody, fontFamily: mono, color: colors.pageInk }}
        >
          {provider}
        </span>
        <VerifiedBadgeView
          state={state}
          opacity={badgeMotion.opacity}
          scale={badgeMotion.scale}
          glowOpacity={badgeMotion.glowOpacity}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          data-testid="dashboard-card-received"
          style={{ ...type.trustFooter, fontFamily: mono, color: colors.pageDim }}
        >
          {received}
        </span>
        <span
          data-testid="dashboard-card-id"
          style={{ ...type.trustFooter, fontFamily: mono, color: colors.pageDim }}
        >
          {id}
        </span>
      </div>
    </div>
  );
}

export interface DashboardCardProps {
  provider: string;
  state: VerifiedState;
  received: string;
  id: string;
  /** Absolute frame the card snaps into place. */
  startFrame: number;
}

/**
 * Thin Remotion wrapper: owns the land motion. Before `startFrame` the card
 * renders nothing — it slams into place, mirroring `EventRow`'s "the row slams
 * into existence" beat (brief S3), it does not fade in. From `startFrame`, the
 * card's own §3.4 overshoot spring drives `scale(1.06→1.0)`, and the composed
 * badge pops (+ verified-only glow) in lockstep, via `VerifiedBadge`'s exported
 * pure helpers.
 */
export function DashboardCard({ provider, state, received, id, startFrame }: DashboardCardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < startFrame) {
    return null;
  }

  const relativeFrame = frame - startFrame;
  const scale = spring({ frame: relativeFrame, fps, config: springs.land, from: 1.06, to: 1 });

  const badgeMotion = {
    opacity: 1,
    scale: badgePopScale(relativeFrame, fps),
    glowOpacity: state === "verified" ? badgeGlowOpacity(relativeFrame) : 0,
  };

  return (
    <DashboardCardView
      provider={provider}
      received={received}
      id={id}
      state={state}
      scale={scale}
      badgeMotion={badgeMotion}
    />
  );
}
