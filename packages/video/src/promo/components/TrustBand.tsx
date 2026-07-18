// TrustBand — the row of trust signals under the S20 end card (brief §3.3 /
// §4.13 / §5 S20).
//
// The film's very last beat: `webhook.co` · `Open source · Apache-2.0 ·
// Private by default` on the minimal off-white close (brief §5 S20). Brief
// §3.3 describes the motif as "an inverse dark strip"; Act IV is committed to
// the LIGHT page instead (brief's global rules — S20 is minimal off-white, and
// green is the film's one saturated accent carried on that light page), so
// this component renders the light-mode variant only: `--page-ink` icons,
// `--page-dim` labels — `type.trustFooter`'s own "22px/400, `--*-dim`" role —
// no inverse dark strip.
//
// Each item (a small inline icon + a real trust-fact label, e.g. "Open
// source") settles in with the brief §3.4 headline-settle spring (no
// bounce — this is a calm closing beat, not a "land" thock), staggered
// left-to-right so the line reads as one confirming breath rather than a
// single flat cut. A dim middle-dot divider precedes every item after the
// first, fading in with that item so the divider never appears "ahead of"
// the label it separates (mirrors the brief's literal
// "Open source · Apache-2.0 · Private by default" string).
//
// Split into pure stagger/settle math (unit-tested directly) + a hook-free
// `TrustBandView` (composes the hook-free `TrustIcon`) + a thin `TrustBand`
// wrapper that owns `useCurrentFrame()`/`useVideoConfig()` — the same
// adapter split used throughout this package (KineticLine/SurfaceTabs/...).

import type { CSSProperties, ReactElement } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { inter } from "../fonts";
import { colors, springs, type } from "../tokens";

/**
 * The five recurring trust glyphs brief §3.3 names: lock (private by
 * default), scale (Apache-2.0), github (a generic mark only — brief's global
 * rules forbid any other third-party logo), hash-chain (durable/append-only
 * capture), layers (RLS / row-level security).
 */
export type TrustIconKind = "lock" | "scale" | "github" | "hash-chain" | "layers";

export interface TrustBandItem {
  icon: TrustIconKind;
  /** The real trust-fact string, rendered byte-for-byte (e.g. "Open source"). */
  label: string;
}

/** Per-item entrance delay, in frames, before the next item begins settling. */
const STAGGER_FRAMES = 4;

/**
 * Absolute frame item `index` begins its own settle-in, given the band's
 * `startFrame`. A pure function of plain numbers — directly unit-testable —
 * mirroring the S9 legend's own "4-frame stagger" (brief §5 S9).
 */
export function itemStartFrame(
  index: number,
  startFrame: number,
  staggerFrames: number = STAGGER_FRAMES,
): number {
  return startFrame + index * staggerFrames;
}

/**
 * The brief §3.4 headline-settle spring (no bounce) as a pure function of
 * `relativeFrame`/`fps` — Remotion's `spring()` takes `fps` as an explicit
 * argument, so this needs no hooks and is directly unit-testable, mirroring
 * `VerifiedBadge.badgePopScale`'s identical shape.
 */
export function itemSettleProgress(relativeFrame: number, fps: number): number {
  return spring({ frame: relativeFrame, fps, config: springs.headlineSettle });
}

const ICON_VIEWBOX = 24;
const GAP = 14;
const DOT_GAP = 14;

/**
 * Pure presentational glyph: a single small inline SVG per `TrustIconKind`,
 * stroked in `currentColor` so it always matches the label color it sits
 * beside. Hand-drawn primitives only — the `"github"` case is a generic,
 * non-reproduced mark (a circle + two small "ear" nubs), never a copy of any
 * real third-party logo, per the brief's global rules.
 */
export function TrustIcon({ kind, size }: { kind: TrustIconKind; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: `0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (kind) {
    case "lock":
      return (
        <svg {...common} data-testid="trust-icon-lock">
          <rect x="5" y="10" width="14" height="9" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case "scale":
      return (
        <svg {...common} data-testid="trust-icon-scale">
          <path d="M12 3v15" />
          <path d="M5 7h14" />
          <path d="M5 7l-2.5 5a2.5 2.5 0 0 0 5 0L5 7Z" />
          <path d="M19 7l-2.5 5a2.5 2.5 0 0 0 5 0L19 7Z" />
          <path d="M8 21h8" />
        </svg>
      );
    case "github":
      return (
        <svg {...common} data-testid="trust-icon-github">
          <circle cx="12" cy="11" r="7" />
          <circle cx="9.3" cy="10" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.7" cy="10" r="0.9" fill="currentColor" stroke="none" />
          <path d="M9 20v-2M15 20v-2" />
        </svg>
      );
    case "hash-chain":
      return (
        <svg {...common} data-testid="trust-icon-hash-chain">
          <rect x="3" y="8" width="10" height="8" rx="4" transform="rotate(-25 8 12)" />
          <rect x="11" y="8" width="10" height="8" rx="4" transform="rotate(-25 16 12)" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common} data-testid="trust-icon-layers">
          <path d="M12 3 21 8 12 13 3 8Z" />
          <path d="M3 12 12 17 21 12" />
          <path d="M3 16 12 21 21 16" />
        </svg>
      );
  }
}

export interface TrustBandViewProps {
  items: readonly TrustBandItem[];
  /** Settle progress (0→1) per item, same length/order as `items`. Plain numbers — no Remotion hooks. */
  progresses: readonly number[];
  /** Uniform scale applied to type/icons/gaps — pass `verticalScale` for the 9:16 cut. Defaults to 1. */
  scale?: number;
}

/**
 * Pure presentational half: takes the already-computed per-item `progresses`
 * as plain numbers (no `useCurrentFrame()`), so it renders like any other
 * React component and is trivially unit-testable in jsdom.
 */
export function TrustBandView({ items, progresses, scale = 1 }: TrustBandViewProps): ReactElement {
  return (
    <div
      data-testid="trust-band"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      {items.map((item, index) => {
        const progress = progresses[index] ?? 0;
        const opacity = interpolate(progress, [0, 1], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const translateY = interpolate(progress, [0, 1], [12, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const itemStyle: CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          gap: GAP * scale,
          opacity,
          transform: `translateY(${translateY * scale}px)`,
          color: colors.pageInk,
        };

        return (
          <div key={item.label} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 ? (
              <span
                style={{
                  ...type.trustFooter,
                  fontFamily: inter,
                  fontSize: type.trustFooter.fontSize * scale,
                  color: colors.pageDim,
                  opacity,
                  margin: `0 ${DOT_GAP * scale}px`,
                }}
              >
                ·
              </span>
            ) : null}
            <div data-testid={`trust-item-${item.label}`} style={itemStyle}>
              <TrustIcon kind={item.icon} size={type.trustFooter.fontSize * scale} />
              <span
                style={{
                  ...type.trustFooter,
                  fontFamily: inter,
                  fontSize: type.trustFooter.fontSize * scale,
                  color: colors.pageDim,
                }}
              >
                {item.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface TrustBandProps {
  items: readonly TrustBandItem[];
  /** Absolute frame the first item begins settling in; later items stagger from here. */
  startFrame: number;
  /** Uniform scale applied to type/icons/gaps — pass `verticalScale` for the 9:16 cut. Defaults to 1. */
  scale?: number;
}

/**
 * Thin Remotion wrapper: owns `useCurrentFrame()`/`useVideoConfig()`, computes
 * each item's staggered headline-settle progress via the pure helpers above,
 * and hands plain numbers down to `TrustBandView`.
 */
export function TrustBand({ items, startFrame, scale = 1 }: TrustBandProps): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progresses = items.map((_, index) => {
    const relativeFrame = frame - itemStartFrame(index, startFrame);
    return itemSettleProgress(relativeFrame, fps);
  });

  return <TrustBandView items={items} progresses={progresses} scale={scale} />;
}
