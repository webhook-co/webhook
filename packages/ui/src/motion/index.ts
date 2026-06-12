/**
 * Motion conventions for Motion (motion.dev).
 *
 * These helpers wrap the motion tokens into ready-to-use transitions and variants so
 * components animate on-brand without re-deriving timing. Three tiers:
 *
 * - **product** — 80–180ms, decisive ease-out, no spring. Fast is the brand.
 * - **marketing** — 280–420ms, fluid ease, staggered. The premium read.
 * - **signature** — the mark drawing itself on, the one permitted flourish.
 *
 * Exits are always faster than entrances. Honor `prefers-reduced-motion` at the call
 * site with {@link prefersReducedMotion}; nothing essential should depend on motion.
 */

import { duration, easing } from "../tokens/motion";

const seconds = (ms: number) => ms / 1000;

/** A swift product transition: decisive ease-out, instant-feeling. */
export const productTransition = {
  duration: seconds(duration.base),
  ease: easing.swift,
} as const;

/** A fluid marketing transition: longer, smooth tail. */
export const marketingTransition = {
  duration: seconds(duration.smooth),
  ease: easing.smooth,
} as const;

/** A faster exit transition — leaving should never linger. */
export const exitTransition = {
  duration: seconds(duration.fast),
  ease: easing.exit,
} as const;

/** Fade + small rise. Movement stays <= 8px in product contexts. */
export const fadeInUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: productTransition,
} as const;

/** Plain cross-fade, e.g. theme changes or content swaps. */
export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: productTransition,
} as const;

/**
 * Stagger children by a fixed step (seconds). Marketing entrances only; product UI
 * should feel simultaneous.
 */
export function stagger(stepMs = duration.fast, startMs = 0) {
  return {
    transition: {
      delayChildren: seconds(startMs),
      staggerChildren: seconds(stepMs),
    },
  } as const;
}

/**
 * Whether the user asked for reduced motion. Returns `false` in non-DOM environments
 * (SSR, tests) so the caller can safely default to the static, finished state.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
