import { LINKS } from "@/lib/links";

/**
 * The navigation, in ONE place — because it is rendered twice (the desktop bar and the mobile menu)
 * and two hand-maintained copies would drift the first time someone adds a page. `nav.test.tsx`
 * asserts the mobile menu offers every destination the desktop bar does, so a link added here can't
 * silently reach only half the site's visitors.
 */

export interface NavLink {
  readonly label: string;
  readonly href: string;
}

/** The Product menu: a dropdown on desktop, a flat group on mobile. All www pages. */
export const PRODUCT_LINKS: readonly NavLink[] = [
  { label: "Capture & replay", href: LINKS.product.captureReplay },
  { label: "Verification", href: LINKS.product.verification },
  { label: "Delivery", href: LINKS.product.delivery },
  { label: "Agent triggers", href: LINKS.product.agentTriggers },
];

/**
 * The top-level links. "Docs" is LAST because it is the only item that hands you off to another
 * domain — everything before it keeps you on this site.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { label: "Pricing", href: LINKS.pricing },
  { label: "About", href: LINKS.about },
  { label: "Docs", href: LINKS.docs },
];

/** Every destination the navigation offers, in reading order. The drift guard checks against this. */
export const ALL_NAV_DESTINATIONS: readonly NavLink[] = [...PRODUCT_LINKS, ...NAV_LINKS];
