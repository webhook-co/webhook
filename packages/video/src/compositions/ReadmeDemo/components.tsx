// components.tsx — the README demo's chrome, brand lockup, and verdict callout.
//
// Every export here is a PURE view: it takes already-computed motion as plain
// props and uses no Remotion hooks, so it renders in jsdom like any other React
// component. The composition wrapper owns `useCurrentFrame()`. This mirrors the
// View/wrapper split used throughout the promo film in this package.

import type { CSSProperties, ReactElement } from "react";

import { Mark } from "@webhook-co/ui";

import { inter, mono } from "../../promo/fonts";
import { colors, radii } from "../../promo/tokens";
import { CHROME_HEIGHT } from "./beats";

export interface DemoLockupProps {
  /** Mark size in px. The wordmark scales with it. */
  size?: number;
}

/**
 * Mark + wordmark. The glyph is the canonical `Mark` from `@webhook-co/ui` —
 * imported, never re-drawn, so a substitute icon can't creep in (an earlier
 * pass had inlined the generic Lucide "webhook" glyph). The name is always
 * lowercase, `webhook` in semibold with `.co` de-emphasised, per the brand
 * lockup rule. `Mark` inherits `currentColor`, so it reads white on this
 * composition's dark surface.
 *
 * We keep the text styling explicit here rather than reusing `ui/Wordmark`:
 * that component fixes the wordmark at `text-xl` and styles via Tailwind theme
 * classes, whereas this lockup scales mark + text together off one `size` prop
 * and must not depend on a theme CSS context inside the Remotion canvas.
 */
export function DemoLockup({ size = 26 }: DemoLockupProps): ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.42,
        color: colors.termFg,
      }}
    >
      <Mark size={size} aria-label="webhook.co" />
      <span
        data-testid="lockup"
        style={{
          fontFamily: inter,
          fontSize: size * 0.85,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        webhook
        <span data-testid="lockup-tld" style={{ fontWeight: 400, color: colors.termDim }}>
          .co
        </span>
      </span>
    </span>
  );
}

export interface WindowChromeViewProps {
  title: string;
}

/** macOS-style title bar: three traffic lights, centred mono title. */
export function WindowChromeView({ title }: WindowChromeViewProps): ReactElement {
  const light = (color: string): CSSProperties => ({
    width: 12,
    height: 12,
    borderRadius: 999,
    backgroundColor: color,
  });

  return (
    <div
      style={{
        position: "relative",
        height: CHROME_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: 18,
        gap: 8,
        backgroundColor: colors.termBg2,
        borderBottom: `1px solid ${colors.termBorder}`,
      }}
    >
      <span data-testid="traffic-light" style={light("#FF5F57")} />
      <span data-testid="traffic-light" style={light("#FEBC2E")} />
      <span data-testid="traffic-light" style={light("#28C840")} />
      <span
        data-testid="window-title"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 16,
          color: colors.termDim,
          pointerEvents: "none",
        }}
      >
        {title}
      </span>
    </div>
  );
}

export interface Band {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CalloutViewProps {
  /** Already-computed envelope in [0, 1]. The wrapper owns the timing. */
  opacity: number;
  band: Band;
}

/**
 * The verdict-column highlight: a soft accent band over the signature column.
 * Renders nothing at zero opacity so a fully faded callout leaves no stray box
 * in the frame. It carries no label of its own — the recording's own footer row
 * sits directly under the band, so the words live in the caption below the
 * window instead.
 */
export function CalloutView({ opacity, band }: CalloutViewProps): ReactElement | null {
  if (opacity <= 0) {
    return null;
  }

  return (
    <div
      data-testid="callout"
      style={{ position: "absolute", inset: 0, opacity, pointerEvents: "none" }}
    >
      <div
        data-testid="callout-band"
        style={{
          position: "absolute",
          left: band.x,
          top: band.y,
          width: band.width,
          height: band.height,
          borderRadius: radii.terminal,
          border: `1.5px solid ${colors.verified}`,
          backgroundColor: "rgba(63,178,127,0.10)",
          boxShadow: `0 0 0 1px rgba(63,178,127,0.10), 0 0 34px ${colors.verifiedGlow}`,
        }}
      />
    </div>
  );
}
