/**
 * Motion tokens — durations and easings.
 *
 * Layered policy: product UI is swift (feedback feels instant — fast is the brand);
 * marketing is smooth (the fluid, premium read). Exits are faster than entrances.
 * `prefers-reduced-motion` is honored unconditionally elsewhere in the system.
 *
 * These are the single source of timing. The animation engine reads the same values
 * (see {@link ../motion/index}); it never invents its own.
 */

/** Durations in ms, smallest to largest. */
export const duration = {
  instant: 80,
  fast: 140,
  base: 180,
  smooth: 280,
  slow: 420,
} as const;

/** Easing curves as cubic-bezier control points. */
export const easing = {
  /** Decisive ease-out — the product default. */
  swift: [0.2, 0, 0, 1],
  /** Long fluid tail — marketing reveals. */
  smooth: [0.32, 0.72, 0, 1],
  /** Tiny overshoot — switches only. */
  spring: [0.34, 1.3, 0.5, 1],
  /** Leave quickly, no lingering. */
  exit: [0.4, 0, 1, 1],
} as const;

export type DurationName = keyof typeof duration;
export type EasingName = keyof typeof easing;

/** Format a cubic-bezier tuple as a CSS `cubic-bezier(...)` value. */
export function cubicBezier(points: readonly [number, number, number, number]): string {
  return `cubic-bezier(${points.join(", ")})`;
}
