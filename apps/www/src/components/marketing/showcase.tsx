import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

import { Pill } from "@/components/ui/pill";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, focusRing } from "@/lib/styles";

export type ShowcaseProps = {
  /** Stable id for the heading + `aria-labelledby` wiring. */
  id: string;
  eyebrow: string;
  title: string;
  body: ReactNode;
  link: { label: string; href: string };
  visual: ReactNode;
  /** When true, the text column moves to the right on desktop (alternating rhythm). */
  flip?: boolean;
  /** A "soon" marker for a not-yet-GA capability. */
  badge?: { label: string };
};

/**
 * The shared two-column showcase row (copy + a visual), used by all four showcases so their gap,
 * breakpoint collapse, flip order, heading level, and hover-lift stay locked together. Copy lives in
 * `showcases.tsx`; this file is copy-free layout.
 */
export function Showcase({
  id,
  eyebrow,
  title,
  body,
  link,
  visual,
  flip = false,
  badge,
}: ShowcaseProps) {
  const titleId = `${id}-title`;
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        container,
        "grid grid-cols-2 items-center gap-[clamp(36px,6vw,84px)] py-[clamp(26px,3vw,38px)] max-[940px]:grid-cols-1",
      )}
    >
      <div className={cn("flex flex-col", flip && "min-[941px]:order-2")}>
        <div className="mb-4 flex items-center gap-2.5">
          <SectionEyebrow>{eyebrow}</SectionEyebrow>
          {badge ? <Pill>{badge.label}</Pill> : null}
        </div>
        <h2
          id={titleId}
          className="mb-4 text-[clamp(24px,3.4vw,32px)] leading-[1.1] font-semibold tracking-heading text-fg"
        >
          {title}
        </h2>
        <p className="mb-5 text-md leading-body text-pretty text-fg-secondary">{body}</p>
        <ShowcaseLink href={link.href}>{link.label}</ShowcaseLink>
      </div>

      <div className="transition-transform duration-300 ease-smooth hover:-translate-y-1">
        {visual}
      </div>
    </section>
  );
}

/** The "→" text link that ends each showcase's copy; the arrow nudges right on hover. */
export function ShowcaseLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={cn(
        focusRing,
        "group/link inline-flex w-fit items-center gap-1.5 rounded-control border-b border-strong pb-px text-sm font-medium tracking-tight text-fg transition-colors hover:border-fg",
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="font-mono transition-transform duration-150 ease-swift group-hover/link:translate-x-[3px]"
      >
        →
      </span>
    </a>
  );
}
