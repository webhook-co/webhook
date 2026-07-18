// TerminalIsland — the film's signature dark panel motif (brief §3.3 / §4.1).
//
// A floating rounded-rect panel: term-bg-2 surface, 14px radius, the brief's
// exact drop shadow, a faux traffic-light header row, an optional header
// title (e.g. "mcp.webhook.co"), and a monospace body that hosts whatever the
// scene composes inside it (TypedLine, EventRow, MCPTranscript, ...). This is
// the reusable container; it owns none of the content's own reveal logic.
//
// Traffic-light dots are deliberately monochrome (term-border), not literal
// red/amber/green macOS chrome: they're "faux" — pure UI-chrome silhouette,
// not a state signal — so the panel never spends the film's one saturated
// accent (green, brief §3.1 "accent discipline") on decoration. The only
// places red/amber legitimately appear are the S7 mutation and the S9 legend.
//
// Split into a hook-free `TerminalIslandView` (a pure function of `progress`,
// unit-tested below) and a thin `TerminalIsland` wrapper that owns
// `useCurrentFrame()` — the same adapter pattern already used by
// `src/scenes/BrandLockup.tsx` / `HeadlineScene.tsx` in this package, so a
// component driven entirely by Remotion hooks still has a jsdom-testable half.
//
// Shadow/overflow are split across two nested divs on purpose: putting both
// `overflow: hidden` (needed to clip the header/body content to the rounded
// corners) and `box-shadow` on the *same* element clips the shadow itself (a
// well-known CSS interaction — overflow's clip region cuts off shadows
// rendered around that same box). The outer div owns the entrance transform +
// shadow; the inner div owns the radius, border, background, and clipping.

import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

import { mono } from "../fonts";
import { colors, motion, radii, shadows, type } from "../tokens";

const HEADER_HEIGHT = 44;
const DOT_SIZE = 10;
const DOT_GAP = 8;
/** Shared horizontal inset for the header row and vertical padding for the body, so the
 * body's left edge lines up with the header's leading traffic-light dot. */
const PANEL_PADDING = 32;

export interface TerminalIslandViewProps {
  /** Faux header title, e.g. "mcp.webhook.co". The traffic-light dots always render. */
  header?: string;
  children: ReactNode;
  /** Panel width in px. Callers may animate this frame-by-frame (e.g. S4's "expands to fill"). */
  width: number;
  /**
   * `true` (default): the floating elevated card — term-bg-2 surface + the brief's drop
   * shadow. `false`: a flat, full-bleed backdrop (term-bg, no shadow) for scenes where the
   * island expands to fill the frame and IS the background rather than a card floating
   * over one (brief S4).
   */
  raised?: boolean;
  /** Entrance progress in [0, 1], already eased by the frame-aware wrapper below. */
  progress: number;
}

/**
 * Pure presentational half: takes already-computed `progress` instead of reading
 * `useCurrentFrame()`, so it renders like any other React component — no Remotion
 * composition context required. Unit-tested in `TerminalIsland.test.tsx`.
 */
export function TerminalIslandView({
  header,
  children,
  width,
  raised = true,
  progress,
}: TerminalIslandViewProps) {
  const opacity = interpolate(progress, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(progress, [0, 1], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(progress, [0, 1], [0.97, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const outerStyle: CSSProperties = {
    width,
    opacity,
    transform: `translateY(${translateY}px) scale(${scale})`,
    borderRadius: radii.terminal,
    boxShadow: raised ? shadows.terminal : "none",
  };

  const surfaceStyle: CSSProperties = {
    borderRadius: radii.terminal,
    border: `1px solid ${colors.termBorder}`,
    backgroundColor: raised ? colors.termBg2 : colors.termBg,
    overflow: "hidden",
    fontFamily: mono,
  };

  return (
    <div data-testid="terminal-island" style={outerStyle}>
      <div data-testid="terminal-island-surface" style={surfaceStyle}>
        <div
          data-testid="terminal-island-header"
          style={{
            height: HEADER_HEIGHT,
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            padding: `0 ${PANEL_PADDING}px`,
            borderBottom: `1px solid ${colors.termBorder}`,
          }}
        >
          <div style={{ display: "flex", gap: DOT_GAP, justifySelf: "start" }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                data-testid="terminal-island-dot"
                style={{
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  borderRadius: DOT_SIZE / 2,
                  backgroundColor: colors.termBorder,
                }}
              />
            ))}
          </div>
          {header === undefined ? (
            <span />
          ) : (
            <span
              data-testid="terminal-island-title"
              style={{
                ...type.badge,
                justifySelf: "center",
                fontFamily: mono,
                color: colors.termDim,
              }}
            >
              {header}
            </span>
          )}
          <span />
        </div>
        <div
          data-testid="terminal-island-body"
          style={{
            padding: PANEL_PADDING,
            color: colors.termFg,
            fontFamily: mono,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export interface TerminalIslandProps {
  header?: string;
  children: ReactNode;
  width: number;
  raised?: boolean;
  /** Composition-absolute frame the entrance begins. Frames before this render at progress 0. */
  enterAtFrame: number;
}

/**
 * Thin Remotion wrapper: owns the motion. Reads `useCurrentFrame()` at this boundary
 * only, eases an entrance `progress` on rails (brief §3.4 "cross-surface travel / wipes":
 * `Easing.inOut(Easing.cubic)` over `motion.railsDurationFrames` — never bouncy, since this
 * is a panel appearing, not a "land" thock), and hands the plain `progress` number down to
 * `TerminalIslandView`.
 */
export function TerminalIsland({
  header,
  children,
  width,
  raised,
  enterAtFrame,
}: TerminalIslandProps) {
  const frame = useCurrentFrame();
  const progress = interpolate(
    frame,
    [enterAtFrame, enterAtFrame + motion.railsDurationFrames],
    [0, 1],
    {
      easing: Easing.inOut(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <TerminalIslandView header={header} width={width} raised={raised} progress={progress}>
      {children}
    </TerminalIslandView>
  );
}
