import { cn, Wordmark } from "@webhook-co/ui";

import { GithubIcon, LinkedinIcon } from "@/components/ui/brand-icons";
import { COMPARISONS, comparisonPath } from "@/lib/comparisons";
import { LINKS } from "@/lib/links";
import { container, focusRing } from "@/lib/styles";

// Every column link now has a real destination (see `@/lib/links`) — About became a page and Blog
// was renamed to Guides (docs), so no column carries a bare label anymore. The inert-until-real
// mechanism lives only on the socials row below (an optional `href`), where X and LinkedIn still have
// no account. If a future column surface genuinely doesn't exist yet, render its label as TEXT rather
// than as an `href="#"` that goes nowhere.
type FooterLink = { label: string; href: string };

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Capture & replay", href: LINKS.product.captureReplay },
      { label: "Verification", href: LINKS.product.verification },
      { label: "Delivery", href: LINKS.product.delivery },
      { label: "Agent triggers", href: LINKS.product.agentTriggers },
      { label: "Pricing", href: LINKS.pricing },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: LINKS.docs },
      { label: "Quickstart", href: LINKS.quickstart },
      { label: "API reference", href: LINKS.apiReference },
      { label: "CLI", href: LINKS.cli },
      { label: "MCP", href: LINKS.mcp },
      { label: "Status", href: LINKS.status },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: LINKS.about },
      // "Blog" was renamed to "Guides" and points at the existing docs guides estate — we don't run
      // a separate blog. (Founder decision, 2026-07-11.)
      { label: "Guides", href: LINKS.guides },
      { label: "Changelog", href: LINKS.changelog },
      { label: "Security", href: LINKS.securityPage },
      { label: "Contact", href: LINKS.contact },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
      { label: "DPA", href: "/dpa" },
      { label: "Acceptable use", href: "/acceptable-use" },
      { label: "Sub-processors", href: "/sub-processors" },
    ],
  },
];

/**
 * Row 2 — a second grid of COLUMNS below the main one. This replaced a full-width wrapping band.
 *
 * The band's original reasoning was: "a column caps out around six links before it unbalances the
 * grid, whereas a band wraps freely." That was true, and it is no longer the binding constraint —
 * because the thing it was worried about (a set that grows) now grows SIDEWAYS. A second group
 * becomes a second column here, not a seventh link inside the first one, and row 2 has two more free
 * tracks after these. The old band could only grow in the one direction that eventually looked bad.
 *
 * What has NOT changed is the rule that actually prevents the failure: link HUBS, not members.
 * Sixteen tutorial slugs here would have read as link-stuffing and orphaned the seventeenth anyway.
 * The Compare column links the hub FIRST and then a capped handful of named comparisons — enough for
 * a reader to see what the estate contains, few enough that the next one goes through the hub.
 * `footer.test.tsx` pins that cap, so it is enforced rather than merely recommended.
 *
 * Row 2 reuses row 1's `1.6fr repeat(4,1fr)` track definition and starts at track 2, so both rows sit
 * on one vertical rhythm and the brand block keeps the left region to itself. At ≤940px it collapses
 * to the same two columns row 1 uses.
 */
const rowTwoColumns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Resources",
    links: [
      { label: "Signature verifier", href: LINKS.verify },
      { label: "Webhook tutorials", href: LINKS.tutorials },
      { label: "Sandbox", href: LINKS.play },
    ],
  },
  {
    // Competitor names are allowed here: this is `apps/www` marketing content, which the founder
    // opened up on 2026-07-22. They must never reach logic code — the engine, CLI, SDKs, API,
    // contracts, the provider registry, migrations, ADRs or docs.
    title: "Compare",
    // Derived, never hand-listed. Hand-pairing a display name with a slug is how a typo ships and
    // waits for a post-build dead-link check to find it — and the hub page makes exactly this
    // argument about its own index, so the footer should not do the opposite two files away.
    //
    // It names EVERY comparison while there are four of them (founder call, 2026-07-22): four
    // competitor links is a useful index rather than link-stuffing, and the hub still leads the
    // column so it remains the thing the estate hangs off. That stops being true as the set grows,
    // so `footer.test.tsx` fails at the fifth comparison and forces the decision then, rather than
    // letting the column quietly grow until the grid unbalances.
    links: [
      { label: "All comparisons", href: LINKS.comparisons },
      ...COMPARISONS.map((c) => ({ label: `vs ${c.name}`, href: comparisonPath(c.slug) })),
    ],
  },
];

// The two socials with a real account: GitHub (the org) and the LinkedIn company page (created
// 2026-07-20). X/Twitter was removed — the founder chose not to create the account, so its mark is
// gone rather than sitting inert and implying a presence that doesn't exist. The optional `href` and
// the inert-mark branch below are kept so a future not-yet-live social can render as a mark, not as an
// `href="#"` that goes nowhere.
const socials: { label: string; icon: typeof GithubIcon; href?: string }[] = [
  { label: "webhook.co on GitHub", icon: GithubIcon, href: LINKS.openSource },
  { label: "webhook.co on LinkedIn", icon: LinkedinIcon, href: LINKS.linkedin },
];

export function Footer() {
  return (
    <footer className="border-t border-hairline pt-[clamp(48px,7vw,80px)] pb-12">
      <div className={container}>
        <div className="grid grid-cols-[1.6fr_repeat(4,1fr)] gap-8 max-[940px]:grid-cols-2">
          <div className="max-[940px]:col-span-full">
            <Wordmark markSize={20} />
            <p className="mt-4 max-w-[32ch] text-sm text-fg-muted">
              Webhooks your AI agents can act on.
            </p>
            <ul className="mt-5 flex gap-2.5">
              {socials.map(({ label, icon: Icon, href }) => {
                const chrome =
                  "inline-grid h-[2.125rem] w-[2.125rem] place-items-center rounded-control border border-hairline text-fg-secondary";
                // No account behind it → the mark still shows, but it isn't a link. An `href="#"`
                // here would announce as a link to a screen reader and, with smooth scrolling now on,
                // glide the reader back to the hero. `aria-hidden` because a non-interactive brand
                // mark is decoration, not information.
                return (
                  <li key={label}>
                    {href ? (
                      <a
                        href={href}
                        aria-label={label}
                        className={cn(
                          focusRing,
                          chrome,
                          "transition-colors hover:bg-surface-sunken hover:text-fg",
                        )}
                      >
                        <Icon size={16} />
                      </a>
                    ) : (
                      <span aria-hidden="true" className={cn(chrome, "text-fg-faint")}>
                        <Icon size={16} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className="text-sm font-semibold tracking-tight text-fg">{column.title}</p>
              <ul className="mt-4 flex flex-col gap-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className={cn(
                        focusRing,
                        "rounded-control text-sm text-fg-muted transition-colors hover:text-fg",
                      )}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* Placed AFTER the column grid on purpose: the socials <ul> must stay the FIRST list in the
            footer, because footer.test.tsx identifies it structurally as `container.querySelector("ul")`
            rather than by a label. Row 2 rendering here keeps that true — and a reader scanning the
            columns meets it as "more places to go" rather than as two stray extra columns. */}
        <div className="mt-[clamp(32px,4vw,48px)] grid grid-cols-[1.6fr_repeat(4,1fr)] gap-8 border-t border-hairline pt-6 max-[940px]:grid-cols-2">
          {rowTwoColumns.map((column, index) => (
            <nav
              key={column.title}
              aria-label={column.title}
              // Track 2 onwards at desktop: the columns line up with row 1's, and the 1.6fr brand
              // track stays clear so the wordmark block owns the left of the whole footer. Below
              // 940px the grid is two equal columns and these take both of them, so the offset has
              // to be dropped or the first column would leave an empty cell beside it.
              className={index === 0 ? "col-start-2 max-[940px]:col-start-1" : undefined}
            >
              <p className="text-sm font-semibold tracking-tight text-fg">{column.title}</p>
              <ul className="mt-4 flex flex-col gap-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className={cn(
                        focusRing,
                        "rounded-control text-sm text-fg-muted transition-colors hover:text-fg",
                      )}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* Still no inline status indicator, and the reason is now a HARD constraint rather than a
            missing status page. apps/www is `output: "export"` — a static export with no server — so
            there is no route handler to proxy the vendor JSON through, and status.webhook.co sends no
            Access-Control-Allow-Origin, so the browser cannot fetch it directly either. A
            server-render fetch turns this footer into a suspense boundary and breaks every page test.
            That leaves Phare's iframe embed as the only mechanism that actually works. The "Status"
            link in the Developers column carries the same information and cannot fail. */}
        <div className="mt-[clamp(40px,5vw,64px)] flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-sm text-fg-muted">
          <span>© 2026 webhook.co</span>
        </div>
      </div>
    </footer>
  );
}
