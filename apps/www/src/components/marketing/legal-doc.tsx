import type { ReactNode } from "react";

import { cn } from "@webhook-co/ui";

import { container } from "@/lib/styles";

/**
 * Long-form legal-document layout. The marketing site ships no prose/typography plugin, so this
 * scopes readable long-form typography to its descendants via arbitrary-descendant utilities: a
 * page authors plain <h2>/<h3>/<p>/<ul>/<blockquote> and gets consistent, on-token legal styling
 * for free. The leading <blockquote> is the plain-language "in short" summary box.
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
      <article className="mx-auto max-w-[72ch]">
        <h1 className="text-3xl font-semibold tracking-tight text-balance text-fg sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-fg-muted">Last updated: {updated}</p>
        <div
          className={cn(
            "mt-10 text-fg-secondary",
            "[&_h2]:mt-12 [&_h2]:scroll-mt-24 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-fg",
            "[&_h3]:mt-8 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-fg",
            "[&_p]:mt-4 [&_p]:leading-relaxed",
            "[&_ul]:mt-4 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5",
            "[&_li]:list-disc [&_li]:leading-relaxed [&_li]:marker:text-fg-faint",
            "[&_strong]:font-semibold [&_strong]:text-fg",
            "[&_a]:font-medium [&_a]:text-fg [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-fg-secondary",
            "[&_blockquote]:mt-8 [&_blockquote]:rounded-control [&_blockquote]:border [&_blockquote]:border-hairline [&_blockquote]:bg-surface-sunken [&_blockquote]:p-5 [&_blockquote]:text-sm [&_blockquote]:leading-relaxed",
          )}
        >
          {children}
        </div>
      </article>
    </div>
  );
}
