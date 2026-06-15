"use client";

import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

import { useScrollReveal } from "@/lib/use-scroll-reveal";

/**
 * Wraps a section so it fades up as it scrolls into view. The treatment is additive: the content is
 * visible in the server HTML and only the elements that start below the fold are hidden-then-revealed
 * (see `useScrollReveal`). With reduced motion, or if JS never runs, the content simply stays visible.
 */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, armed, revealed } = useScrollReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cn(
        armed && !revealed && "reveal-hidden",
        armed && revealed && "reveal-in",
        className,
      )}
    >
      {children}
    </div>
  );
}
