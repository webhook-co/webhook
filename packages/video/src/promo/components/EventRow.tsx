// EventRow — one monospace events-table row (brief §4.3).
//
// Renders the real listen/table fields — `received` (ISO timestamp),
// `provider` (e.g. "linear"), `state` (drives the badge color via
// `VerifiedBadge`/`stateColor`), and `id` — laid out in fixed monospace
// columns roughly matching the brief's `EVENTS_TABLE` alignment (brief §6.1).
// Used for both the S4 live `wbhk listen` line and the S6/S12 table-style event
// listings.
//
// Land is the exact §3.4 overshoot spring (`scale(1.06→1.0)`) — the row "slams
// into existence" at `startFrame` (brief S3): it renders nothing before that
// frame, never fades in. `highlight` calls the row out with the `--wire`
// underline motif (brief §3.1: "packets, connectors, underlines") and pops its
// badge (reusing `VerifiedBadge`'s own overshoot + verified-only glow) — the
// S3/S16 "row lands, verified token pops + glow" beat.
//
// Split into a hook-free `EventRowView` (composes `VerifiedBadgeView`
// directly, not the hook-wrapping `VerifiedBadge`, so it stays fully
// testable in jsdom with no Remotion composition context) + a thin
// `EventRow` wrapper that owns `useCurrentFrame()`/`useVideoConfig()` and
// computes both the row's own land spring and the composed badge's motion via
// `VerifiedBadge`'s exported pure helpers — the same adapter split used by
// `TypedLine`/`TerminalIsland`/`VerifiedBadge` in this package.

import { spring, useCurrentFrame, useVideoConfig } from "remotion";

import { mono } from "../fonts";
import { colors, springs, type } from "../tokens";
import {
  badgeGlowOpacity,
  badgePopScale,
  type VerifiedBadgeViewProps,
  VerifiedBadgeView,
  type VerifiedState,
} from "./VerifiedBadge";

// Roughly mirrors brief §6.1's EVENTS_TABLE column widths (received ~26ch,
// provider ~10ch, state ~15ch, id fills the rest) so a row of `EventRow`s
// reads as the same table shape as the pre-formatted string block.
const COLUMN_TEMPLATE = "26ch 10ch 15ch 1fr";

export interface EventRowViewProps {
  received: string;
  provider: string;
  state: VerifiedState;
  id: string;
  /** Row-level overshoot scale, 1.06→1.0 as it lands. A plain number — no Remotion hooks. */
  scale: number;
  /** Calls the row out with the `--wire` underline. Defaults to `false`. */
  highlight?: boolean;
  /** The composed badge's own opacity/scale/glow — already computed by the wrapper. */
  badgeMotion: Pick<VerifiedBadgeViewProps, "opacity" | "scale" | "glowOpacity">;
}

/**
 * Pure presentational half: takes the already-computed row scale + composed
 * badge motion as plain props (no `useCurrentFrame()`), so it renders like any
 * other React component and is trivially unit-testable in jsdom.
 */
export function EventRowView({
  received,
  provider,
  state,
  id,
  scale,
  highlight = false,
  badgeMotion,
}: EventRowViewProps) {
  return (
    <div
      data-testid="event-row"
      style={{
        display: "grid",
        gridTemplateColumns: COLUMN_TEMPLATE,
        alignItems: "center",
        columnGap: 4,
        fontFamily: mono,
        ...type.terminalBody,
        color: colors.termFg,
        transform: `scale(${scale})`,
        paddingBottom: 8,
        borderBottom: `2px solid ${highlight ? colors.wire : "transparent"}`,
      }}
    >
      <span data-testid="event-row-received">{received}</span>
      <span data-testid="event-row-provider" style={{ color: colors.termDim }}>
        {provider}
      </span>
      <VerifiedBadgeView
        state={state}
        opacity={badgeMotion.opacity}
        scale={badgeMotion.scale}
        glowOpacity={badgeMotion.glowOpacity}
      />
      <span data-testid="event-row-id" style={{ color: colors.termDim }}>
        {id}
      </span>
    </div>
  );
}

export interface EventRowProps {
  received: string;
  provider: string;
  state: VerifiedState;
  id: string;
  /** Absolute frame the row slams into existence. */
  startFrame: number;
  /** Calls the row out + pops its badge (verified-only glow). Defaults to `false`. */
  highlight?: boolean;
}

/**
 * Thin Remotion wrapper: owns the land motion. Before `startFrame` the row
 * renders nothing — it slams into existence (brief §5 S3), it does not fade
 * in. From `startFrame`, the row's own §3.4 overshoot spring drives
 * `scale(1.06→1.0)`, and the composed badge gets the same "pop" treatment
 * (via `VerifiedBadge`'s exported pure helpers) whenever `highlight` is set.
 */
export function EventRow({
  received,
  provider,
  state,
  id,
  startFrame,
  highlight = false,
}: EventRowProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < startFrame) {
    return null;
  }

  const relativeFrame = frame - startFrame;
  const scale = spring({ frame: relativeFrame, fps, config: springs.land, from: 1.06, to: 1 });

  // The composed badge lands together with the row (no separate fade-in — the
  // row's own mount already gates its visibility), and only pops/glows when
  // the row itself is highlighted.
  const badgeMotion = {
    opacity: 1,
    scale: highlight ? badgePopScale(relativeFrame, fps) : 1,
    glowOpacity: highlight && state === "verified" ? badgeGlowOpacity(relativeFrame) : 0,
  };

  return (
    <EventRowView
      received={received}
      provider={provider}
      state={state}
      id={id}
      scale={scale}
      highlight={highlight}
      badgeMotion={badgeMotion}
    />
  );
}
