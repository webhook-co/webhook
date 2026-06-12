/**
 * Shape & depth tokens — radii, shadows, focus ring.
 *
 * Mixed radius policy: crisp on controls, soft on containers. Shadows are soft and
 * cool-tinted, never warm, never colored. Dark mode deepens the shadow and adds a
 * 1px light ring so edges stay readable.
 */

export const radius = {
  control: "6px",
  card: "10px",
  modal: "14px",
  pill: "999px",
  tile: "22.5%",
} as const;

/** Four levels of soft, cool-tinted depth. */
export const shadowLight = {
  1: "0 1px 2px rgb(14 20 27 / 0.06)",
  2: "0 1px 2px rgb(14 20 27 / 0.05), 0 2px 8px rgb(14 20 27 / 0.06)",
  3: "0 2px 6px rgb(14 20 27 / 0.05), 0 10px 28px rgb(14 20 27 / 0.1)",
  4: "0 4px 12px rgb(14 20 27 / 0.08), 0 28px 72px rgb(14 20 27 / 0.18)",
} as const;

/** Deeper black plus a 1px light ring keeps edges legible on dark surfaces. */
export const shadowDark = {
  1: "0 0 0 1px rgb(255 255 255 / 0.04), 0 1px 2px rgb(0 0 0 / 0.5)",
  2: "0 0 0 1px rgb(255 255 255 / 0.04), 0 2px 10px rgb(0 0 0 / 0.5)",
  3: "0 0 0 1px rgb(255 255 255 / 0.05), 0 10px 32px rgb(0 0 0 / 0.6)",
  4: "0 0 0 1px rgb(255 255 255 / 0.06), 0 28px 80px rgb(0 0 0 / 0.7)",
} as const;

/**
 * Focus ring: a 2px offset ring in the focus color, always visible. References the
 * page surface and border-focus tokens so it adapts per theme.
 */
export const focusRing = "0 0 0 2px var(--wh-surface-page), 0 0 0 4px var(--wh-border-focus)";
