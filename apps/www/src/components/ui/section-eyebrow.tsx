import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

/**
 * The small mono label that precedes a section heading. By default it carries a short leading
 * rule (the machined "eyebrow" detail); pass `rule={false}` for the centered Resources head where
 * the rule would float oddly. It's a `<span>`, not a heading — the real `<h2>` follows it.
 */
export function SectionEyebrow({
  children,
  rule = true,
  className,
}: {
  children: ReactNode;
  rule?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-mono text-xs tracking-mono-label text-fg-muted uppercase",
        rule && "before:mr-3 before:h-px before:w-[22px] before:bg-strong before:content-['']",
        className,
      )}
    >
      {children}
    </span>
  );
}
