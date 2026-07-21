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
 * The Resources menu: the three things a visitor can actually USE without an account — the signature
 * verifier, the tutorial hub, and the sandbox. All www pages.
 *
 * This menu exists because of a measured failure, not a hunch. The sixteen `/test/<slug>` tutorials
 * shipped with zero inbound internal links from anywhere on the site, and `/play` had exactly one
 * (the homepage hero) — so both were effectively reachable only from a search result. Sitemap
 * membership is not discoverability.
 *
 * It points at the tutorial HUB, never at individual slugs: a dropdown that enumerated providers
 * would cap out immediately and would have to be edited for every new tutorial. Same reason any
 * future comparison estate should get a hub here rather than one entry per page.
 */
export const RESOURCE_LINKS: readonly NavLink[] = [
  { label: "Signature verifier", href: LINKS.verify },
  { label: "Webhook tutorials", href: LINKS.tutorials },
  { label: "Sandbox", href: LINKS.play },
];

/**
 * The top-level links. "Docs" is LAST because it is the only item that hands you off to another
 * domain — everything before it keeps you on this site.
 *
 * "About" is deliberately NOT here. It is still a page, still in the footer's Company column, and
 * still the canonical anchor for the Person/Organization JSON-LD — so it stays reachable, linkable
 * and indexable. It just doesn't need a slot in the primary nav, which is for what the product does.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { label: "Pricing", href: LINKS.pricing },
  { label: "Docs", href: LINKS.docs },
];

/** Every destination the navigation offers, in reading order. The drift guard checks against this. */
export const ALL_NAV_DESTINATIONS: readonly NavLink[] = [
  ...PRODUCT_LINKS,
  ...RESOURCE_LINKS,
  ...NAV_LINKS,
];
