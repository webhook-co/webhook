// SurfaceTabs — the four-surface tab chrome (brief §4.12 / §5 S12).
//
// S12 shows the SAME event four ways in quick succession — mcp · cli · api ·
// web — with a small `--verified` underline that sweeps to whichever surface
// is active, so "same event. every surface." reads as one continuity motif.
// This component owns ONLY the tab labels + that shared underline sweep; the
// scene composes its own per-surface content (MCPTranscript / listen line /
// API path / DashboardCard) alongside it, per this file's ROLE brief.
//
// Layout switches on `format` (brief §8.1's "stack ... vertically instead of
// side-by-side" applied here): a single row for 16:9, a 2x2 grid for the 9:16
// cut — `columnsForFormat` below is the pure math behind that switch.
//
// `startFrame` is the absolute frame `activeIndex` BECAME active (mirrors
// `DashboardCard`/`EventRow`'s own `startFrame` = "when this thing lands"
// convention). From there the active tab's underline sweeps in on the exact
// brief §3.4 cross-surface-rails timing (`motion.railsDurationFrames`, eased
// `Easing.inOut(Easing.cubic)` — the same wipe `TerminalIsland`'s entrance
// uses), then carries a brief `--verified-glow` pulse reusing
// `VerifiedBadge.badgeGlowOpacity`'s own decay curve, so each surface swap
// reads as a confirming beat, not a static label change.
//
// Split into pure position/sweep/glow math (unit-tested in
// `SurfaceTabs.test.ts`) + a hook-free `SurfaceTabsView` + a thin
// `SurfaceTabs` wrapper that owns `useCurrentFrame()` — the same adapter
// split used throughout this package (KineticLine/EventRow/DashboardCard/...).

import { Easing, interpolate, useCurrentFrame } from "remotion";

import { mono } from "../fonts";
import { colors, motion, type } from "../tokens";
import type { Format } from "../tokens";
import { badgeGlowOpacity } from "./VerifiedBadge";

const EASE_INOUT_CUBIC = Easing.inOut(Easing.cubic);

/** Columns per row for the 9:16 vertical cut's 2x2 grid (brief §4.12 / §8.1). */
const VERTICAL_GRID_COLUMNS = 2;

/**
 * How many grid columns the tab row lays out in: one row of `tabCount` for
 * 16:9, or the 9:16 cut's 2x2 grid (capped at `tabCount` so a shorter `tabs`
 * list never asks for more columns than it has tabs). A pure function of
 * plain values — no Remotion hooks — so it's directly unit-testable.
 */
export function columnsForFormat(format: Format, tabCount: number): number {
  return format === "9x16" ? Math.min(VERTICAL_GRID_COLUMNS, tabCount) : tabCount;
}

/**
 * The active underline's horizontal sweep-in, 0 (not yet swept) -> 1 (fully
 * under the tab), eased over the brief's exact cross-surface-rails duration
 * (`motion.railsDurationFrames`, `Easing.inOut(Easing.cubic)` — §3.4, the same
 * curve `TerminalIsland`'s own entrance wipe uses). Clamped both ends: 0 at
 * or before the tab becomes active, held at 1 once fully swept.
 */
export function underlineSweepProgress(
  relativeFrame: number,
  durationFrames: number = motion.railsDurationFrames,
): number {
  return interpolate(relativeFrame, [0, durationFrames], [0, 1], {
    easing: EASE_INOUT_CUBIC,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * The underline's `--verified-glow` pulse accompanying the sweep: reuses
 * `VerifiedBadge.badgeGlowOpacity`'s exact decay curve (1 at the moment the
 * tab becomes active, decaying to 0 over the film's shared
 * `motion.ringPulse.durationFrames` window) so a tab's arrival reads as the
 * same confirming flash as every other "land" in the film. Explicitly 0
 * before the tab is active — `badgeGlowOpacity` alone would clamp a negative
 * input back up to its own peak, which would read as an unearned glow.
 */
export function underlineGlowOpacity(relativeFrame: number): number {
  if (relativeFrame < 0) return 0;
  return badgeGlowOpacity(relativeFrame);
}

const UNDERLINE_HEIGHT = 3;
const UNDERLINE_MAX_GLOW_BLUR = 14;
const TAB_GAP = 48;
const LABEL_GAP = 10;

export interface SurfaceTabsViewProps {
  /** The four real surface labels, lowercase, byte-for-byte (e.g. ["mcp","cli","api","web"]). */
  tabs: readonly string[];
  /** Index into `tabs` of the currently active/lead surface. */
  activeIndex: number;
  /** Grid columns to lay tabs out in — see `columnsForFormat`. */
  columns: number;
  /** Active tab's underline sweep-in, 0->1. A plain number — no Remotion hooks. */
  sweep: number;
  /** Active tab's underline glow pulse, 0->1. A plain number — no Remotion hooks. */
  glow: number;
  /** Uniform scale applied to type/gaps — pass `verticalScale` for the 9:16 cut. Defaults to 1. */
  scale?: number;
}

/**
 * Pure presentational half: takes the already-computed `sweep`/`glow` as
 * plain numbers (no `useCurrentFrame()`), so it renders like any other React
 * component and is trivially unit-testable in jsdom. Only `tabs[activeIndex]`
 * ever shows the underline — every other tab renders it fully collapsed and
 * transparent, never a stale sweep left behind from a previous active tab.
 */
export function SurfaceTabsView({
  tabs,
  activeIndex,
  columns,
  sweep,
  glow,
  scale = 1,
}: SurfaceTabsViewProps) {
  return (
    <div
      data-testid="surface-tabs"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, auto)`,
        gap: TAB_GAP * scale,
      }}
    >
      {tabs.map((label, index) => {
        const isActive = index === activeIndex;
        return (
          <div
            key={label}
            data-testid={`surface-tab-${label}`}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: LABEL_GAP * scale,
            }}
          >
            <span
              style={{
                fontFamily: mono,
                ...type.badge,
                fontSize: type.badge.fontSize * scale,
                color: isActive ? colors.termFg : colors.termDim,
              }}
            >
              {label}
            </span>
            <div
              data-testid={`surface-tab-underline-${label}`}
              style={{
                width: "100%",
                height: UNDERLINE_HEIGHT * scale,
                borderRadius: UNDERLINE_HEIGHT,
                background: colors.verified,
                transformOrigin: "left",
                transform: `scaleX(${isActive ? sweep : 0})`,
                opacity: isActive ? 1 : 0,
                boxShadow:
                  isActive && glow > 0
                    ? `0 0 ${Math.round(UNDERLINE_MAX_GLOW_BLUR * glow)}px ${colors.verifiedGlow}`
                    : "none",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export interface SurfaceTabsProps {
  /** The four real surface labels, lowercase, byte-for-byte (e.g. ["mcp","cli","api","web"]). */
  tabs: readonly string[];
  /** Index into `tabs` of the currently active/lead surface. */
  activeIndex: number;
  /** Absolute frame `activeIndex` became active — the underline sweeps in from here. */
  startFrame: number;
  /** Row (16:9) vs the 2x2 grid (9:16, brief §8.1). Defaults to `"16x9"`. */
  format?: Format;
  /** Uniform scale applied to type/gaps — pass `verticalScale` for the 9:16 cut. Defaults to 1. */
  scale?: number;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`, computes the active tab's
 * underline sweep + glow relative to `startFrame` via the pure helpers above,
 * and hands plain numbers down to `SurfaceTabsView`.
 */
export function SurfaceTabs({
  tabs,
  activeIndex,
  startFrame,
  format = "16x9",
  scale = 1,
}: SurfaceTabsProps) {
  const frame = useCurrentFrame();
  const relativeFrame = frame - startFrame;
  const columns = columnsForFormat(format, tabs.length);
  const sweep = underlineSweepProgress(relativeFrame);
  const glow = underlineGlowOpacity(relativeFrame);

  return (
    <SurfaceTabsView
      tabs={tabs}
      activeIndex={activeIndex}
      columns={columns}
      sweep={sweep}
      glow={glow}
      scale={scale}
    />
  );
}
