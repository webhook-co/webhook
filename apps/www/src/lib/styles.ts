/**
 * Shared className fragments for the marketing site. Keeping these in one place means the
 * page's column width and the keyboard focus treatment have a single source of truth — change
 * them here, not in every section.
 */

/** The centered marketing column: the max content width + the horizontal gutter. */
export const container = "mx-auto max-w-[var(--container-max)] px-6";

/**
 * The design-system focus ring, shown only on keyboard focus (`:focus-visible`). Pair it with a
 * `rounded-*` on the element so the ring follows the corners.
 */
export const focusRing = "outline-none focus-visible:shadow-[var(--wh-focus-ring)]";
