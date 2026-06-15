import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

/**
 * The small inverse-ink marker pill — "new", "soon". One recipe shared by the announcement bar,
 * the hero, and the showcase "soon" markers so they can't drift apart.
 */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-pill bg-surface-inverse px-2 py-0.5 font-mono text-[10px] tracking-mono-label text-fg-on-inverse uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}
