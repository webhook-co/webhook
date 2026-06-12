/**
 * Typography tokens — one sans, one mono, four weights.
 *
 * Geist for everything human; Geist Mono for everything a machine produced — ids,
 * urls, timestamps, status codes, cli output, the `.co` in the lockup. Tracking
 * tightens as type grows. Sentence case everywhere; Title Case never.
 */

export const fontFamily = {
  sans: '"Geist", ui-sans-serif, system-ui, -apple-system, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace',
} as const;

/** Type scale, in px. `base` is the product-UI default; `md` is marketing/docs body. */
export const fontSize = {
  xs: "12px",
  sm: "13px",
  base: "14px",
  md: "16px",
  lg: "18px",
  xl: "22px",
  "2xl": "28px",
  "3xl": "36px",
  "4xl": "48px",
  "5xl": "64px",
} as const;

/** Geist is variable; 620 is the brand's "semibold". */
export const fontWeight = {
  regular: "400",
  medium: "500",
  semibold: "620",
  bold: "700",
} as const;

export const tracking = {
  body: "0",
  tight: "-0.015em",
  heading: "-0.025em",
  display: "-0.035em",
  monoLabel: "0.06em",
} as const;

export const leading = {
  tight: "1.1",
  snug: "1.3",
  body: "1.55",
  relaxed: "1.7",
} as const;
