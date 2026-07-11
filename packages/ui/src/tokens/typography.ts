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

/**
 * Type scale, in **rem** — root-relative on purpose.
 *
 * Authored against the browser's default 16px root, so the comment on each step is what it renders
 * at today. We never set `font-size` on `html`: that leaves the root equal to the reader's own
 * browser preference, and the whole scale (plus spacing, which is already rem) moves with it. An
 * absolute px scale would ignore that preference entirely — browser *zoom* would still work, but the
 * default-font-size setting, the one a low-vision reader is most likely to have already changed,
 * would do nothing.
 *
 * Two sizes carry the load, and the distinction is the point:
 * - `base` is the **product-UI default** — the dashboard's body, dense by design.
 * - `md` is the **long-form reading size** — marketing and legal prose opt into it. Reading a
 *   contract is not the same task as scanning a delivery table, and the sizes shouldn't pretend
 *   otherwise.
 *
 * `sm` is the dense workhorse (table cells, labels, metadata), not a size for prose. If a paragraph
 * is set in `sm`, that's a bug: the reader has to work harder than the body default asks them to.
 */
export const fontSize = {
  xs: "0.75rem", // 12px — mono labels, column headers, badges. Scanned, never read.
  sm: "0.875rem", // 14px — table cells, field labels, metadata.
  base: "0.9375rem", // 15px — product-UI body. The default for all three apps.
  md: "1rem", // 16px — long-form reading: legal + marketing prose.
  lg: "1.125rem", // 18px — ledes.
  xl: "1.375rem", // 22px
  "2xl": "1.75rem", // 28px
  "3xl": "2.25rem", // 36px
  "4xl": "3rem", // 48px
  "5xl": "4rem", // 64px
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
