import { cn, Wordmark } from "@webhook-co/ui";

import { GithubIcon, LinkedinIcon, XIcon } from "@/components/ui/brand-icons";
import { LINKS } from "@/lib/links";
import { container, focusRing } from "@/lib/styles";

// A footer link is either a bare label — which still renders as an inert `#` — or a {label, href}
// pair. Every destination that EXISTS is now wired (see `@/lib/links`). The handful that remain bare
// are the surfaces we genuinely don't have: About, Blog, and the socials. They're left inert on
// purpose rather than pointed somewhere approximate, because a link whose label lies is worse than a
// link that doesn't go anywhere.
type FooterLink = string | { label: string; href: string };

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: LINKS.home },
      { label: "Capture & replay", href: LINKS.concepts.captureAndReplay },
      { label: "Ingestion", href: LINKS.concepts.ingestion },
      { label: "Delivery", href: LINKS.concepts.delivery },
      { label: "MCP server", href: LINKS.concepts.mcpServer },
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
    ],
  },
  {
    title: "Company",
    links: [
      "About", // no page yet
      "Blog", // no blog yet
      { label: "Changelog", href: LINKS.changelog },
      { label: "Security", href: LINKS.security },
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

// GitHub is the only social that exists. X and LinkedIn have no accounts behind them, so they stay
// inert rather than linking nowhere-in-particular.
const socials: { label: string; icon: typeof GithubIcon; href?: string }[] = [
  { label: "webhook.co on X", icon: XIcon },
  { label: "webhook.co on GitHub", icon: GithubIcon, href: LINKS.openSource },
  { label: "webhook.co on LinkedIn", icon: LinkedinIcon },
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
                {column.links.map((link) => {
                  const label = typeof link === "string" ? link : link.label;
                  // A bare label has no destination (About, Blog). It renders as TEXT, not as a link
                  // to nowhere: an `href="#"` is focusable, announces as a link, and — now that an
                  // in-page click enables smooth scrolling — would glide the reader all the way back
                  // to the hero. Saying "this exists but isn't a page yet" quietly is the honest
                  // version of that.
                  if (typeof link === "string") {
                    return (
                      <li key={label} className="text-sm text-fg-muted">
                        {label}
                      </li>
                    );
                  }
                  return (
                    <li key={label}>
                      <a
                        href={link.href}
                        className={cn(
                          focusRing,
                          "rounded-control text-sm text-fg-muted transition-colors hover:text-fg",
                        )}
                      >
                        {label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ))}
        </div>

        {/* No "All systems operational" indicator. It was a hardcoded string next to a green dot,
            with nothing monitoring anything — its own comment admitted "there is no status page to
            point at". A health indicator that isn't wired to a health check is a lie told in the most
            trustworthy-looking way available. It comes back when a real status page does. */}
        <div className="mt-[clamp(40px,5vw,64px)] flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-sm text-fg-muted">
          <span>© 2026 webhook.co</span>
        </div>
      </div>
    </footer>
  );
}
