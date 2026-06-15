import { Button, cn, Wordmark } from "@webhook-co/ui";

import { NavMenus } from "@/components/marketing/nav-menus";
import { container, focusRing } from "@/lib/styles";

// Plain top-level links; the Product / Developers dropdowns are the <NavMenus/> client island.
const navLinks = [
  { label: "Pricing", href: "#" },
  { label: "Changelog", href: "#" },
];

export function Nav() {
  return (
    <div className="site-nav sticky top-0 z-50 border-b border-hairline">
      <div className={cn(container, "flex h-[60px] items-center justify-between")}>
        <a
          href="/"
          aria-label="webhook.co home"
          className={cn(focusRing, "inline-flex items-center rounded-control")}
        >
          <Wordmark markSize={22} />
        </a>

        <nav aria-label="Main" className="flex items-center gap-0.5 max-[940px]:hidden">
          <NavMenus />
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className={cn(
                focusRing,
                "inline-flex h-[34px] items-center rounded-control px-3 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <a
            href="#"
            className={cn(
              focusRing,
              "inline-flex h-[34px] items-center rounded-control px-3 text-sm text-fg-secondary transition-colors hover:text-fg",
            )}
          >
            Sign in
          </a>
          <Button asChild size="md">
            <a href="#">Start free</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
