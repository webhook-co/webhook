import { Button, cn, Wordmark } from "@webhook-co/ui";

import { NavMenus } from "@/components/marketing/nav-menus";
import { LINKS } from "@/lib/links";
import { container, focusRing } from "@/lib/styles";

// Plain top-level links; the Product / Developers dropdowns are the <NavMenus/> client island.
const navLinks = [
  { label: "Pricing", href: "/pricing" },
  { label: "Changelog", href: LINKS.changelog },
];

export function Nav() {
  return (
    <div className="site-nav sticky top-0 z-50 border-b border-hairline">
      <div className={cn(container, "flex h-[3.75rem] items-center justify-between")}>
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
                "inline-flex h-[2.125rem] items-center rounded-control px-3 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* One CTA, not two. "Sign in" and "Start free" landed the same visitor in the same place —
            app.webhook.co bounces a signed-out user to the login screen, which itself says "No account
            yet? Signing in creates one." Two labels for one door is just a choice the reader has to
            make for no reason. "Get started" also does the right thing for someone already signed in:
            straight to the dashboard, which "Sign in" would not. */}
        <Button asChild size="md">
          <a href={LINKS.startFree}>Get started</a>
        </Button>
      </div>
    </div>
  );
}
