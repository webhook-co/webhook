/**
 * Shared className fragments for the marketing site. Keeping these in one place means the
 * page's column width and the keyboard focus treatment have a single source of truth — change
 * them here, not in every section.
 */

/** The centered marketing column: the max content width + the horizontal gutter. */
export const container = "mx-auto max-w-[var(--container-max)] px-6";

/** The default vertical rhythm for a top-level content band. */
export const sectionPad = "py-[clamp(44px,5.5vw,76px)]";

/**
 * The design-system focus ring, shown only on keyboard focus (`:focus-visible`). Pair it with a
 * `rounded-*` on the element so the ring follows the corners.
 */
export const focusRing = "outline-none focus-visible:shadow-[var(--wh-focus-ring)]";

/**
 * The treatment for an inline link inside prose — a quiet underline that darkens on hover, so a link
 * in body copy reads as a link without shouting. One source of truth for the product pages and the
 * homepage showcases (legal prose has its own descendant-selector rule in LegalDoc).
 */
export const proseLink =
  "rounded-control border-b border-strong font-medium text-fg transition-colors hover:border-fg";
