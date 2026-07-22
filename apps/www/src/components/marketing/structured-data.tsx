import { absoluteUrl, SITE_URL } from "@/app/metadata";

// The JSON-LD graph: pure builders (unit-testable without React) + the server components that bake
// them into the static HTML at build time (no client JS, cookieless). This is the machine-readable
// half of entity resolution: it tells search engines that "webhook.co" is a specific Organization
// (not the generic noun, and not the homonym free tool it's currently confused with) and names the
// Person behind it. We mark up ONLY what is real and visible — no `SoftwareApplication` (its rich
// result is app-store-shaped and invites a fabricated rating), no `SearchAction` (there is no site
// search), and never a fabricated `sameAs`.

export const ORG_ID = `${SITE_URL}/#organization`;
export const PERSON_ID = `${SITE_URL}/#founder`;
export const WEBSITE_ID = `${SITE_URL}/#website`;

/** A node's `@id` reference shorthand. */
type Ref = { "@id": string };

export interface OrganizationNode {
  "@type": "Organization";
  "@id": string;
  name: string;
  url: string;
  logo: string;
  founder: Ref;
  sameAs?: string[];
}

export interface PersonNode {
  "@type": "Person";
  "@id": string;
  name: string;
  jobTitle: string;
  worksFor: Ref;
  url: string;
  image?: string;
  sameAs?: string[];
}

export interface WebSiteNode {
  "@type": "WebSite";
  "@id": string;
  name: string;
  url: string;
  publisher: Ref;
}

export function organizationNode(): OrganizationNode {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: "webhook.co",
    url: SITE_URL,
    // Google's Organization logo wants a raster (it can drop SVGs) → the rendered PNG mark.
    logo: `${SITE_URL}/logo.png`,
    founder: { "@id": PERSON_ID },
    // Every entry is a REAL, founder-confirmed profile for the Organization itself — never invent one.
    // These off-site nodes are what let search/answer engines resolve "webhook.co" as one entity: the
    // LinkedIn company page and Crunchbase org were created 2026-07-20 and cross-link back to the site.
    sameAs: [
      "https://github.com/webhook-co",
      "https://www.linkedin.com/company/webhook-co",
      "https://www.crunchbase.com/organization/webhook-co",
    ],
  };
}

export function personNode(): PersonNode {
  // Name + role + location are already public on the legal pages (terms/privacy/dpa name the sole
  // trader in Porto, PT), so this adds no disclosure — it just makes the founder↔company relationship
  // machine-readable. Every `sameAs` here is a REAL, founder-confirmed profile: a hallucinated one is
  // the exact mistake the entity research flagged, and the point of this node is to be believed.
  return {
    "@type": "Person",
    "@id": PERSON_ID,
    name: "Sourabh Choraria",
    jobTitle: "Founder",
    worksFor: { "@id": ORG_ID },
    url: `${SITE_URL}/about`,
    // The same photo the /about page renders — self-hosted, so the entity's image is one we control.
    image: `${SITE_URL}/sourabh-choraria.webp`,
    sameAs: ["https://www.linkedin.com/in/choraria/", "https://github.com/choraria"],
  };
}

export function websiteNode(): WebSiteNode {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: "webhook.co",
    url: SITE_URL,
    publisher: { "@id": ORG_ID },
  };
}

/** The site-wide graph baked into every page: organization + founder + website. */
export function siteGraph(): Array<OrganizationNode | PersonNode | WebSiteNode> {
  return [organizationNode(), personNode(), websiteNode()];
}

export interface BreadcrumbListNode {
  "@type": "BreadcrumbList";
  itemListElement: Array<{ "@type": "ListItem"; position: number; name: string; item: string }>;
}

/** A BreadcrumbList for an inner page, e.g. Home › About. Item URLs are absolute. */
export function breadcrumbList(
  crumbs: ReadonlyArray<{ name: string; path: string }>,
): BreadcrumbListNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

export interface HowToStepNode {
  "@type": "HowToStep";
  position: number;
  name: string;
  text: string;
}

export interface HowToNode {
  "@type": "HowTo";
  name: string;
  description?: string;
  step: HowToStepNode[];
}

/**
 * A HowTo for a genuinely step-structured page — the /test/<provider> tutorials, whose visible content
 * is a create → point → trigger → replay procedure. Marked up ONLY where the page really is a how-to
 * (never sitewide): the hub and the verifier tool are not procedures and carry none of this.
 *
 * Deliberately shaped as a PROCESS, not a product: no `offers`, no `aggregateRating`, no app-store
 * fields. That is what keeps it clear of the fabricated-rating trap that keeps `SoftwareApplication`
 * off this site (see the header note). Google retired the HowTo *rich result* in 2023, so this earns
 * no SERP feature; it is emitted for answer-engine/LLM readability, and its steps mirror the visible
 * prose so the markup can never say something the page does not.
 */
export function howToNode({
  name,
  description,
  steps,
}: {
  name: string;
  description?: string;
  steps: ReadonlyArray<{ name: string; text: string }>;
}): HowToNode {
  if (steps.length === 0) {
    throw new Error("howToNode: a HowTo with no steps is not a HowTo");
  }
  return {
    "@type": "HowTo",
    name,
    ...(description ? { description } : {}),
    step: steps.map((s, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

function jsonLdScript(payload: object) {
  // Escape `<` as its JSON unicode form so a `</script>` sequence can never appear in the emitted
  // text — the one way a JSON-LD `dangerouslySetInnerHTML` block can break out of its <script>.
  // Today every payload is a static in-repo constant, but these builders are reusable (breadcrumbs
  // take arbitrary crumbs), so the sink is hardened at the sink rather than trusting every caller.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/**
 * The site-wide graph rendered ONCE via the root layout, so every page carries the entity data. It's
 * first in document order, which the SEO gate relies on when it asserts the homepage carries an
 * Organization node.
 */
export function StructuredData() {
  return jsonLdScript({ "@context": "https://schema.org", "@graph": siteGraph() });
}

/**
 * A standalone BreadcrumbList for an inner page (e.g. Home › About). Emitted as its OWN script so it
 * doesn't duplicate the site graph the layout already renders on every page.
 */
export function BreadcrumbJsonLd({
  crumbs,
}: {
  crumbs: ReadonlyArray<{ name: string; path: string }>;
}) {
  return jsonLdScript({ "@context": "https://schema.org", ...breadcrumbList(crumbs) });
}

/**
 * A standalone HowTo script for a tutorial page. Emitted as its own `<script>`, alongside (not merged
 * with) the breadcrumb, so each machine-readable claim stands on its own.
 */
export function HowToJsonLd(props: {
  name: string;
  description?: string;
  steps: ReadonlyArray<{ name: string; text: string }>;
}) {
  return jsonLdScript({ "@context": "https://schema.org", ...howToNode(props) });
}
