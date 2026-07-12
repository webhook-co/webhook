import { Button, cn, ThemeToggle, Wordmark } from "@webhook-co/ui";

import { NavMenus } from "@/components/marketing/nav-menus";
import { NAV_LINKS } from "@/components/marketing/nav-links";
import { MobileNav } from "@/components/marketing/mobile-nav";
import { LINKS } from "@/lib/links";
import { container, focusRing } from "@/lib/styles";

// The links live in `nav-links.ts` — ONE source, because they are rendered twice (this bar and the
// mobile menu) and two copies would drift the first time someone adds a page.

export function Nav() {
  return (
    <div className="site-nav sticky top-0 z-50 border-b border-hairline">
      <div className={cn(container, "relative flex h-[3.75rem] items-center justify-between")}>
        <a
          href="/"
          aria-label="webhook.co home"
          className={cn(focusRing, "inline-flex items-center rounded-control")}
        >
          <Wordmark markSize={22} />
        </a>

        <nav aria-label="Main" className="flex items-center gap-0.5 max-[940px]:hidden">
          <NavMenus />
          {NAV_LINKS.map((link) => (
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
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild size="md" className="max-[940px]:hidden">
            <a href={LINKS.startFree}>Get started</a>
          </Button>
          <MobileNav />
        </div>
      </div>
    </div>
  );
}
