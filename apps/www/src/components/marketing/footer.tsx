import { cn, Wordmark } from "@webhook-co/ui";

import { GithubIcon, LinkedinIcon, XIcon } from "@/components/ui/brand-icons";
import { container, focusRing } from "@/lib/styles";

const columns = [
  {
    title: "Product",
    links: ["Overview", "Capture & replay", "Ingestion", "Delivery", "MCP server", "Pricing"],
  },
  {
    title: "Developers",
    links: [
      "Docs",
      "Quickstart",
      "API reference",
      "CLI",
      "MCP",
      "Standard Webhooks",
      "Open source",
    ],
  },
  { title: "Company", links: ["About", "Blog", "Changelog", "Security", "Contact"] },
  { title: "Legal", links: ["Terms", "Privacy", "DPA"] },
];

const socials = [
  { label: "webhook.co on X", icon: XIcon },
  { label: "webhook.co on GitHub", icon: GithubIcon },
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
              {socials.map(({ label, icon: Icon }) => (
                <li key={label}>
                  <a
                    href="#"
                    aria-label={label}
                    className={cn(
                      focusRing,
                      "inline-grid h-[34px] w-[34px] place-items-center rounded-control border border-hairline text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
                    )}
                  >
                    <Icon size={16} />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className="text-sm font-semibold tracking-tight text-fg">{column.title}</p>
              <ul className="mt-4 flex flex-col gap-3">
                {column.links.map((link) => (
                  <li key={link}>
                    <a
                      href="#"
                      className={cn(
                        focusRing,
                        "rounded-control text-sm text-fg-muted transition-colors hover:text-fg",
                      )}
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-[clamp(40px,5vw,64px)] flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-sm text-fg-muted">
          <span>© 2026 webhook.co</span>
          <a
            href="#"
            className={cn(
              focusRing,
              "inline-flex items-center gap-2 rounded-control transition-colors hover:text-fg",
            )}
          >
            <span className="h-[7px] w-[7px] rounded-pill bg-ok" aria-hidden="true" />
            All systems operational
          </a>
        </div>
      </div>
    </footer>
  );
}
