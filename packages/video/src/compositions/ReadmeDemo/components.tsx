// components.tsx — the README demo's chrome, brand lockup, and verdict callout.
//
// Every export here is a PURE view: it takes already-computed motion as plain
// props and uses no Remotion hooks, so it renders in jsdom like any other React
// component. The composition wrapper owns `useCurrentFrame()`. This mirrors the
// View/wrapper split used throughout the promo film in this package.

import type { CSSProperties, ReactElement } from "react";

import { inter, mono } from "../../promo/fonts";
import { colors, radii } from "../../promo/tokens";

/**
 * The canonical webhook.co mark — three continuous arcs, copied byte-for-byte
 * from packages/ui/src/components/mark.tsx. Exported so a test can pin the
 * geometry: a previous pass silently substituted the generic Lucide "webhook"
 * glyph, which is not the brand mark.
 */
export const MARK_PATHS = [
  "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2",
  "m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06",
  "m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
] as const;

export interface DemoLockupProps {
  /** Mark size in px. The wordmark scales with it. */
  size?: number;
}

/**
 * Mark + wordmark. The name is always lowercase — `webhook` in semibold with
 * `.co` de-emphasised, per the brand lockup rule. The mark inherits
 * `currentColor` so it reads white on this composition's dark surface.
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
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label="webhook.co"
      >
        {MARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
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
        height: 44,
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
  /**
   * Optional. Omitted inside the terminal: the recording's own footer row
   * (`↑/↓ move · r replay …`) sits directly under the band, so a label there
   * overprints real output. The bottom caption carries the words instead.
   */
  label?: string;
}

/**
 * The verdict-column highlight: a soft accent band over the signature column
 * plus a label beneath it. Renders nothing at zero opacity so a fully faded
 * callout leaves no stray box in the frame.
 */
export function CalloutView({ opacity, band, label }: CalloutViewProps): ReactElement | null {
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
      {label === undefined ? null : (
        <div
          data-testid="callout-label"
          style={{
            position: "absolute",
            left: band.x + band.width / 2,
            top: band.y + band.height + 14,
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            fontFamily: mono,
            fontSize: 15,
            letterSpacing: "0.02em",
            color: colors.verified,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
