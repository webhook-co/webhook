"use client";

import { Button, cn, ThemeToggle } from "@webhook-co/ui";
import { Menu, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  NAV_LINKS,
  PRODUCT_LINKS,
  REPO_LINK,
  RESOURCE_LINKS,
} from "@/components/marketing/nav-links";
import { GithubIcon } from "@/components/ui/brand-icons";
import { LINKS } from "@/lib/links";
import { focusRing } from "@/lib/styles";

/**
 * The navigation on a phone.
 *
 * WHY THIS EXISTS: the desktop bar is `max-[940px]:hidden`, and for a while there was NOTHING behind
 * it — below 940px the site had a logo and a "Get started" button and no way to reach Product,
 * Pricing, About or Docs at all. It shipped that way because every Playwright project was
 * `Desktop Chrome`: the a11y suite had literally never rendered a phone. There is now a mobile
 * project too, so this is guarded rather than merely written.
 *
 * A DISCLOSURE, not a menu: these are navigation links, so the correct pattern is a button with
 * `aria-expanded` + `aria-controls` revealing a list — not the `menu`/`menuitem` roles, which
 * describe application menus and make a screen reader promise arrow-key semantics we don't implement.
 * (Same reasoning as NavMenus.)
 *
 * The links are rendered in the DOM even while collapsed (hidden with `hidden`, not unmounted), so
 * they exist for a crawler and for a reader with JS off — the site is a static export, and the nav
 * shouldn't depend on hydration to be present.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    // Return focus to the trigger ONLY when the close was a deliberate dismissal (Escape). Doing it
    // on a link click would yank focus back to the burger as the next page loads.
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    // Click-outside: a panel you can only close with the button is a trap on a small screen.
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  const linkClass = cn(
    focusRing,
    "flex items-center rounded-control px-3 py-2.5 text-md text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
  );

  return (
    <div ref={rootRef} className="min-[941px]:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          focusRing,
          "inline-flex h-[2.125rem] w-[2.125rem] items-center justify-center rounded-control text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
        )}
      >
        {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      {/* Anchored under the sticky header, full-bleed. `hidden` (not unmounted) so the links are in the
          static HTML for a crawler and for a no-JS reader. */}
      <div
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-[3.75rem] max-h-[calc(100dvh-3.75rem)] overflow-y-auto border-b border-hairline bg-surface-page px-4 pt-3 pb-6 shadow-2"
      >
        <nav aria-label="Main">
          <p className="px-3 pt-2 pb-1 font-mono text-xs tracking-tight text-fg-muted">Product</p>
          <ul>
            {PRODUCT_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={linkClass} onClick={() => close()}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          <p className="px-3 pt-4 pb-1 font-mono text-xs tracking-tight text-fg-muted">Resources</p>
          <ul>
            {RESOURCE_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={linkClass} onClick={() => close()}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          <ul className="mt-2 border-t border-hairline pt-2">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={linkClass} onClick={() => close()}>
                  {link.label}
                </a>
              </li>
            ))}

            {/* The repo. A labelled row here, a bare mark in the desktop bar — same destination, and
                `REPO_LINK` is the one source, so the parity guard above covers it. On a phone there is
                room for the word, and an unlabelled octocat in a list of words would be a puzzle. */}
            <li key={REPO_LINK.href}>
              <a
                href={REPO_LINK.href}
                target="_blank"
                rel="noreferrer"
                className={linkClass}
                onClick={() => close()}
              >
                <GithubIcon size={16} aria-hidden="true" className="mr-2" />
                {REPO_LINK.label}
              </a>
            </li>
          </ul>
        </nav>

        {/* The theme toggle lives HERE below 941px, not in the bar.
            The bar has room for the wordmark, one CTA and the burger — and no more: at 360px the
            wordmark alone takes 153 of the 312 available px. Something had to give, and between a
            once-ever appearance preference and the only action the page is asking for, the preference
            is the one that can afford a tap. It is MOVED, not dropped: `nav.tsx` hides its copy below
            941px and this one above it, so exactly one is ever in the a11y tree.

            Labelled, for the same reason the repo row above is: the toggle is icon-only, and a bare
            sun in a list of words is a puzzle. The word is not the accessible name — the button
            carries "Switch to light/dark theme" itself — it is the sighted reader's label. */}
        <div className="mt-2 flex items-center justify-between border-t border-hairline px-3 pt-3">
          <span className="text-md text-fg-secondary">Theme</span>
          <ThemeToggle />
        </div>

        {/* The CTA is in the header at every width, but repeating it at the end of an opened menu is
            where a thumb already is. */}
        <div className="mt-4 px-3">
          <Button asChild size="md" className="w-full">
            <a href={LINKS.startFree} onClick={() => close()}>
              Get started
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
