import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";

/**
 * The "Skip to content" link every page renders as its first focusable element (WCAG 2.4.1). It's
 * visually hidden until focused, then pins to the top-left. Extracted to one component so the focus
 * treatment can't drift between pages — a per-page copy could fall out of sync and no axe test would
 * catch it (the class string stays "valid", just inconsistent). Targets the page's `<main id="main">`.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className={cn(
        focusRing,
        "sr-only rounded-control bg-surface px-4 py-2 text-sm text-fg shadow-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100]",
      )}
    >
      Skip to content
    </a>
  );
}
