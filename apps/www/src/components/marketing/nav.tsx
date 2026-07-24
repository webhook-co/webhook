import { Button, cn, ThemeToggle, Wordmark } from "@webhook-co/ui";

import { NavMenus } from "@/components/marketing/nav-menus";
import { NAV_LINKS, REPO_LINK } from "@/components/marketing/nav-links";
import { MobileNav } from "@/components/marketing/mobile-nav";
import { GithubIcon } from "@/components/ui/brand-icons";
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

          {/* The repo, as a mark. It sits INSIDE the nav rather than beside the theme toggle so it is
              part of the navigation for a screen reader and for the mobile-parity guard, and it is an
              icon rather than a word because it is the one item here that leaves for a third party —
              a text "GitHub" would read as another page of ours.

              NO STAR COUNT, and that is a decision rather than an omission. A count is social proof
              only when it is flattering; a bar that announces a small number converts a neutral visit
              into a negative one, on every page, for every visitor. Add the count when it is an asset. */}
          <a
            href={REPO_LINK.href}
            aria-label={REPO_LINK.label}
            target="_blank"
            rel="noreferrer"
            className={cn(
              focusRing,
              "ml-1 inline-flex h-[2.125rem] w-[2.125rem] items-center justify-center rounded-control text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
            )}
          >
            <GithubIcon size={18} aria-hidden="true" />
          </a>
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
