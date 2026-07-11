import type { ReactNode } from "react";

import { cn } from "@webhook-co/ui";

import { container } from "@/lib/styles";

/**
 * Long-form legal-document layout. The marketing site ships no prose/typography plugin, so this
 * scopes readable long-form typography to its descendants via arbitrary-descendant utilities: a
 * page authors plain <h2>/<h3>/<p>/<ul>/<blockquote> and gets consistent, on-token legal styling
 * for free. The leading <blockquote> is the plain-language "in short" summary box.
 *
 * Typography here is set for READING, not scanning — which is what makes it different from the rest
 * of the platform:
 *
 * - **`text-md` (16px), not the inherited body default (15px).** The design system has always
 *   carried a reading size and its token file has always called it "marketing/docs body"; this
 *   column simply never opted in, so a contract rendered at the same size as a delivery table.
 * - **`58ch`, not `72ch`.** A `ch` is the advance of the "0" glyph, wider than the average
 *   character — so 72ch is really ~90 characters a line, past WCAG 1.4.8's 80 and well past the
 *   45–75 that reads comfortably. And because `ch` tracks the font size, a bigger font makes the
 *   column physically wider without shortening the line. Both had to move together.
 * - **Nothing inside the column is set smaller than the prose.** The "in short" box was 13px — the
 *   smallest text on the page was the part most people actually read.
 */
export function LegalDoc({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(container, "py-[clamp(44px,5.5vw,76px)]")}>
      <article className="mx-auto max-w-[58ch]">
        <h1 className="text-3xl font-semibold tracking-tight text-balance text-fg sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-fg-muted">Last updated: {updated}</p>
        <div
          className={cn(
            "mt-10 text-md text-fg-secondary",
            "[&_h2]:mt-12 [&_h2]:scroll-mt-24 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-fg",
            "[&_h3]:mt-8 [&_h3]:scroll-mt-24 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-fg",
            "[&_p]:mt-6 [&_p]:leading-relaxed",
            "[&_ul]:mt-6 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5",
            "[&_li]:list-disc [&_li]:leading-relaxed [&_li]:marker:text-fg-faint",
            "[&_strong]:font-semibold [&_strong]:text-fg",
            // The prose-link treatment (medium weight, underlined) is for links *in prose*. It must
            // not reach a heading's own permalink — a section heading that happens to be a link is
            // still a heading, and `[&_a]` would otherwise underline it and drop it to weight 500.
            // `:where()` contributes no specificity, so this stays a plain (0,1,1) descendant rule
            // and AnchoredHeading's own classes still win inside it.
            "[&_:where(p,li,td,th,blockquote)_a]:font-medium [&_:where(p,li,td,th,blockquote)_a]:text-fg [&_:where(p,li,td,th,blockquote)_a]:underline [&_:where(p,li,td,th,blockquote)_a]:underline-offset-2 hover:[&_:where(p,li,td,th,blockquote)_a]:text-fg-secondary",
            "[&_blockquote]:mt-8 [&_blockquote]:rounded-control [&_blockquote]:border [&_blockquote]:border-hairline [&_blockquote]:bg-surface-sunken [&_blockquote]:p-5 [&_blockquote]:leading-relaxed",
            // Tables are reference data inside a reading column — the one place a step down from the
            // prose is right, because you scan a sub-processor row, you don't read it.
            "[&_table]:mt-6 [&_table]:w-full [&_table]:border-collapse [&_table]:text-base",
            "[&_th]:border-b [&_th]:border-hairline [&_th]:py-3 [&_th]:pr-4 [&_th]:text-left [&_th]:align-top [&_th]:font-semibold [&_th]:text-fg",
            "[&_td]:border-b [&_td]:border-hairline [&_td]:py-3 [&_td]:pr-4 [&_td]:align-top [&_td]:leading-relaxed",
          )}
        >
          {children}
        </div>
      </article>
    </div>
  );
}
