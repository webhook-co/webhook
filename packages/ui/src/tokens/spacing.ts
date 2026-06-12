/**
 * Spacing tokens — a 4px base grid. Nothing accidental.
 *
 * Every gap is a token. Sections separate by whitespace first, a hairline second —
 * never a divider wall.
 */
export const space = {
  "0.5": "2px",
  1: "4px",
  "1.5": "6px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  7: "28px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
  20: "80px",
  24: "96px",
} as const;

/** Layout measures. The marketing column sits a touch tight, on purpose. */
export const container = {
  /** Marketing & docs column, centered, wide gutters. */
  max: "1120px",
  /** Long-form reading measure; keep body lines <= 70ch. */
  prose: "680px",
} as const;
