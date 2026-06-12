/**
 * Semantic color tokens — meaning, not pigment.
 *
 * Components reference these names (surface, text, border, functional state), never
 * raw ink stops. That indirection is what makes light/dark a free swap: each theme
 * supplies its own values for the same names.
 *
 * Light is the canonical brand surface; dark is a first-class product preference.
 * Functional colors (ok / warn / danger / info) are the only chroma in the UI and
 * exist solely to carry state. The chart ramp is deliberately desaturated so data
 * viz stays calm next to the vivid state colors.
 */

import { ink } from "./ink";

export interface SemanticTheme {
  /** Backgrounds, lightest to most-recessed plus the inverse (button) surface. */
  readonly surface: {
    readonly page: string;
    readonly card: string;
    readonly sunken: string;
    readonly raised: string;
    readonly inverse: string;
  };
  /** Text emphasis ladder, plus text drawn on the inverse surface. */
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    readonly muted: string;
    readonly faint: string;
    readonly onInverse: string;
  };
  /** Hairline and stronger separators, and the focus-ring color. */
  readonly border: {
    readonly hairline: string;
    readonly strong: string;
    readonly focus: string;
  };
  /** The only chroma in the product: each state has a fill, a tint bg, and a border. */
  readonly state: Record<
    "ok" | "warn" | "danger" | "info",
    { readonly fg: string; readonly bg: string; readonly border: string }
  >;
  /** Desaturated categorical ramp for multi-series charts. */
  readonly chart: readonly [string, string, string, string, string];
}

export const light: SemanticTheme = {
  surface: {
    page: ink[50],
    card: ink[0],
    sunken: ink[100],
    raised: ink[0],
    inverse: ink[950],
  },
  text: {
    primary: ink[950],
    secondary: ink[600],
    muted: ink[500],
    faint: ink[400],
    onInverse: ink[50],
  },
  border: {
    hairline: ink[200],
    strong: ink[300],
    focus: ink[950],
  },
  state: {
    ok: { fg: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
    warn: { fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
    danger: { fg: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
    info: { fg: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  },
  chart: ["#5b7a9d", "#5f8d7a", "#b08d57", "#8d7a9d", "#64748b"],
};

export const dark: SemanticTheme = {
  surface: {
    page: ink[1000],
    card: "#11161d",
    sunken: "#080b0f",
    raised: "#161d26",
    inverse: "#edf2f7",
  },
  text: {
    primary: "#edf2f7",
    secondary: "#a9b4c4",
    muted: "#7e8ca0",
    faint: "#5a6878",
    onInverse: ink[950],
  },
  border: {
    hairline: "#1d2632",
    strong: "#2a3542",
    focus: "#edf2f7",
  },
  state: {
    ok: { fg: "#22c55e", bg: "rgba(34, 197, 94, 0.1)", border: "rgba(34, 197, 94, 0.32)" },
    warn: { fg: "#f59e0b", bg: "rgba(245, 158, 11, 0.1)", border: "rgba(245, 158, 11, 0.32)" },
    danger: { fg: "#ef4444", bg: "rgba(239, 68, 68, 0.1)", border: "rgba(239, 68, 68, 0.32)" },
    info: { fg: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)", border: "rgba(59, 130, 246, 0.34)" },
  },
  chart: ["#7d9cc0", "#7fae9a", "#cfa76b", "#a995c0", "#8a99ad"],
};

export type StateName = keyof SemanticTheme["state"];
