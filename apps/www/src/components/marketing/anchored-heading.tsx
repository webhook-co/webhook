import type { ReactNode } from "react";

import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";

/**
 * A section heading that is permanently deep-linkable: hover (or tab to) it and a `#` appears in the
 * gutter; click it and the URL carries the section.
 *
 * Deliberately a **server component with no JavaScript at all** — a plain `<a href="#id">`. The
 * browser updates the URL, pushes history, and scrolls natively, including on a cold load where the
 * hash is already in the URL, which is how a cited link is actually opened. (We don't use `next/link`
 * for same-page fragments: it has no route to prefetch and a long tail of scroll bugs.) That keeps
 * the legal pages 100% server-rendered and the static export untouched.
 *
 * Two decisions here are load-bearing for accessibility:
 *
 * 1. **The link wraps the heading text.** So its accessible name *is* the heading — free, real, and
 *    unable to drift. A bare "#" link is the standard way to ship a `link-name` violation (screen
 *    readers announce "link, pound sign"), and it also makes the tap target a ~10px glyph, which
 *    fails WCAG 2.5.8. Wrapping makes the whole heading line the target, so both problems vanish
 *    rather than being mitigated.
 * 2. **The glyph is revealed with opacity, and on `:focus-visible` as well as hover.**
 *    `display:none`/`visibility:hidden` would remove it from the a11y tree *and* make it
 *    unfocusable — so focus could never reveal it, which is exactly the hover-only trap that leaves
 *    keyboard users with an invisible focusable target (WCAG 2.4.7).
 */
export function AnchoredHeading({
  id,
  children,
  level = 2,
}: {
  /**
   * The permanent fragment for this section.
   *
   * These are pasted into signed agreements and vendor security questionnaires, so they are part of
   * the public contract: **semantic, never positional, and append-only.** Deriving them from the
   * heading text would tie them to the copy — and our headings are numbered, so renumbering a
   * section would silently break every citation to it. See `legal-anchors.ts`.
   */
  id: string;
  children: ReactNode;
  level?: 2 | 3;
}) {
  const Tag = level === 2 ? "h2" : "h3";

  return (
    // `relative` here, so the glyph hangs in the margin next to the heading — but the GROUP is the
    // link, not the heading. `group-focus-visible` keys off the group element's own state, and it is
    // the <a> that takes focus, so a group on the <h2> would never fire. (jsdom cannot see this: the
    // classes are all present and correct, and nothing happens.)
    <Tag id={id} className="relative scroll-mt-24">
      <a
        href={`#${id}`}
        className={cn(
          focusRing,
          "group/anchor",
          // Colour and underline are inherited/neutralised here; the WEIGHT is not defended at this
          // level, and deliberately so. `font-[inherit]` used to sit here as a supposed guard against
          // LegalDoc's `[&_a]:font-medium` — but Tailwind types a non-numeric arbitrary `font-[…]` as
          // a font-FAMILY, so it compiled to `font-family: inherit` and defended nothing. Worse, it
          // read as a belt-and-braces that a reviewer would trust.
          //
          // A descendant selector on an ancestor outranks any class here anyway, so the only real fix
          // is the one in legal-doc.tsx: scope the prose-link rule to prose. Rather than keep a class
          // that looks like protection and isn't, the invariant is pinned where it can actually fail —
          // a computed-style assertion in the real-browser suite (`font-weight: 620`).
          "rounded-control text-inherit no-underline",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute -left-6 hidden select-none font-normal text-fg-muted opacity-0 transition-opacity md:inline",
            "group-hover/anchor:opacity-100 group-focus-visible/anchor:opacity-100",
          )}
        >
          #
        </span>
        {children}
      </a>
    </Tag>
  );
}
