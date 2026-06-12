/**
 * Ink scale — the one color in the system.
 *
 * A single cool-slate ramp carries the entire identity. There is no brand accent
 * color: links are ink, the primary button is inverse ink. Chromatic pigment is
 * reserved for functional state and data viz (see {@link ./semantic}). Keeping the
 * base monochrome is what lets the functional colors actually mean something.
 *
 * Stops run light (`0` = white) to dark (`1000` = the darkest canvas). `950` is the
 * primary near-black "ink"; `1000` is "void".
 */
export const ink = {
  0: "#ffffff",
  25: "#fcfdfe",
  50: "#f8fafc",
  100: "#f1f5f9",
  200: "#e2e8f0",
  300: "#cbd5e1",
  400: "#94a3b8",
  500: "#64748b",
  600: "#475569",
  700: "#334155",
  800: "#1e293b",
  900: "#0f172a",
  950: "#0e141b",
  1000: "#0b0f14",
} as const;

export type InkStop = keyof typeof ink;
