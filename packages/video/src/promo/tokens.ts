// tokens.ts — the promo film's self-contained design system.
//
// This film is BESPOKE (brief §3): it does NOT use @webhook-co/ui, the @wh-*
// tokens, Geist, or Tailwind. Everything below is copied byte-for-byte from the
// brief's §3.1 (color), §3.2 (typography), §3.3 (motifs), §3.4 (motion).
// Consume via inline styles only.

/**
 * Aspect-ratio the film renders at. Scene components switch layout on this and
 * scale type by `verticalScale` for the vertical cut (brief §8).
 */
export type Format = "16x9" | "9x16";

/**
 * Color tokens — EXACT hex/rgba from brief §3.1. Green (`verified`) is the only
 * saturated accent in the film, except the S7 mutation (red) and the S9 legend.
 */
export const colors = {
  // Surfaces
  termBg: "#0B0D10", // near-black terminal island
  termBg2: "#12151A", // raised panel inside terminal
  termBorder: "#232A33", // 1px hairline borders in terminal
  pageBg: "#F7F6F3", // off-white page (light acts)
  pagePanel: "#FFFFFF", // dashboard card surface
  pageBorder: "#E3E1DB", // card hairline on page

  // Text
  termFg: "#E6EDF3", // primary mono text on dark
  termDim: "#6E7681", // muted / secondary on dark
  pageInk: "#0B0D10", // primary text on light
  pageDim: "#5B6069", // secondary text on light

  // The single accent + state colors
  verified: "#3FB27F", // THE accent. verified/success only
  verifiedGlow: "rgba(63,178,127,0.45)",
  authenticated: "#D29922", // amber — weaker auth state
  failed: "#F85149", // desaturated red — used sparingly
  unattempted: "#6E7681", // grey
  wire: "rgba(63,178,127,0.35)", // packets, connectors, underlines
} as const;

/**
 * Type scale (brief §3.2), tuned for the 16:9 master. Values are numbers so they
 * drop straight into an inline `fontSize` (the no-absolute-type-size guard only
 * bans the Tailwind `text-[Npx]` utility, not inline px). Multiply sizes by
 * `verticalScale` for the 9:16 cut. Each role spreads directly into a style
 * object. Fonts: `hero`/`caption`/`trustFooter` use Inter; the terminal/product
 * strings use JetBrains Mono (see fonts.ts) — the role objects carry size/weight
 * only, callers pick the family per the brief's mono-vs-display rule.
 */
export const type = {
  /** Hero kinetic line — 84px / 600, tight tracking (Inter). */
  hero: { fontSize: 84, fontWeight: 600, letterSpacing: "-0.02em" },
  /** Section caption — 40px / 400 (Inter). */
  caption: { fontSize: 40, fontWeight: 400 },
  /** Terminal body mono — 30px / 400, line-height 1.5 (JetBrains Mono). */
  terminalBody: { fontSize: 30, fontWeight: 400, lineHeight: 1.5 },
  /** Badge / label — 24px / 500, letter-spacing 0.04em, lowercase. */
  badge: {
    fontSize: 24,
    fontWeight: 500,
    letterSpacing: "0.04em",
    textTransform: "lowercase",
  },
  /** Trust footer — 22px / 400, on a `*-dim` color. */
  trustFooter: { fontSize: 22, fontWeight: 400 },
} as const;

/** Vertical (9:16) type multiplier — brief §3.2 / §8.1. */
export const verticalScale = 1.4;

/**
 * Motion spring configs — EXACT from brief §3.4. These are the two configs that
 * drive Remotion's `spring()`. §3.4's other motions (typing, ring-pulse,
 * cross-surface rails) are eased, not sprung — they live in `motion` below.
 */
export const springs = {
  /** Type settle / headline reveal — no bounce. translateY(12→0) + opacity(0→1). */
  headlineSettle: { damping: 200, stiffness: 120, mass: 0.6 },
  /** Land / snap-in ("thock") — overshoot. scale(1.06→1.0) on rows/badges. */
  land: { damping: 12, stiffness: 200, mass: 0.8 },
} as const;

/**
 * Non-spring motion constants — brief §3.4. Deterministic values for typing,
 * the ring-pulse, cross-surface rails, and the camera push.
 */
export const motion = {
  /** Typing reveal: 1 char per frame (≈30 chars/s at 30fps). */
  typingCps: 30,
  /** Block cursor `▉` blink at 2Hz: Math.floor(frame/15) % 2. */
  cursorBlinkFrames: 15,
  /** Ring-pulse land radiate — scale 0.6→2.4, opacity 0.5→0 over 24f, ease-out cubic. */
  ringPulse: {
    scaleFrom: 0.6,
    scaleTo: 2.4,
    opacityFrom: 0.5,
    opacityTo: 0,
    durationFrames: 24,
  },
  /** Cross-surface travel / wipes — on rails, eased inOut cubic, ~18–24f moves. */
  railsDurationFrames: 21,
  /** Camera push ceiling — ≤4% over a scene; no hard zooms. */
  cameraPushMax: 0.04,
} as const;

/** Title-safe inner margins in px, per format — brief §2 / §8. */
export const titleSafe = {
  "16x9": 96,
  "9x16": 80,
} as const;

/** Corner radii in px — the terminal island is 14px (brief §3.3). */
export const radii = {
  terminal: 14,
} as const;

/** Box-shadows — the terminal island's soft float (brief §3.3). */
export const shadows = {
  terminal: "0 24px 80px rgba(0,0,0,0.5)",
} as const;
