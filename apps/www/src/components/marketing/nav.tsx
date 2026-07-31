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
        {/* THE MARK ALONE BELOW 360px. The full lockup is 153px wide — nearly half of a 320px bar's
            272px of usable space — and with the CTA now in the bar at every width, the three controls
            no longer fit under it: at 320px the burger ended up 1px past the viewport with the
            wordmark jammed flush against the CTA's white edge. The bar is exactly saturated at 360px,
            so that is where the name goes. It is dropped VISUALLY only — the link's accessible name is
            `aria-label`, not the text, so a screen reader still hears "webhook.co home" at every
            width. (The `>span` is the name; the mark is an `<svg>` and is untouched.) */}
        <a
          href="/"
          aria-label="webhook.co home"
          className={cn(
            focusRing,
            "inline-flex items-center rounded-control max-[359px]:[&>span>span]:hidden",
          )}
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
        {/* AT EVERY WIDTH, including a phone. It used to be `max-[940px]:hidden`, which put the one
            action this site asks for behind the burger — and the hero deliberately carries no sign-up
            button, justified in its own source by "the nav's 'Get started' button is the same door, in
            view on the same screen". Below 940px that was simply untrue, so a phone visitor's only
            route to an account was: notice the burger, open it, scroll the panel. NN/g measured hidden
            navigation at about HALF the discoverability of visible navigation (+2.5s task time, +15%
            perceived difficulty); the conversion CTA is the last thing that should pay that tax. The
            bar is `sticky top-0`, so this CTA is now in view at every scroll depth on every page.

            THE THEME TOGGLE MOVES INTO THE MENU below 941px rather than the CTA staying hidden,
            because the bar genuinely has no room for both: at 360px the wordmark takes 153 of 312
            available px, leaving ~83 — not enough for a CTA until the toggle's 42px come back. Theme
            is a once-ever preference; signing up is the page's purpose. It is MOVED, not dropped —
            `mobile-nav.tsx` renders it in the panel, and only ever one of the two is in the a11y
            tree, because each is `display:none` at the other's width. */}
        <div className="flex items-center gap-2">
          <span className="max-[940px]:hidden">
            <ThemeToggle />
          </span>
          {/* One button, sized down below 941px — the `md` control (42px tall, 20px padding) is wider
              than a 360px bar can spare. `sm`'s 34px matches the bar's other controls exactly. */}
          <Button
            asChild
            size="md"
            className="max-[940px]:h-[2.125rem] max-[940px]:px-3.5 max-[940px]:text-sm"
          >
            <a href={LINKS.startFree}>Get started</a>
          </Button>
          <MobileNav />
        </div>
      </div>
    </div>
  );
}
