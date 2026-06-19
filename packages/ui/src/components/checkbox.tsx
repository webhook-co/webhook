import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * A checkbox built on Radix — keyboard-toggleable (Space), focus-ringed, and supporting
 * an `indeterminate` state (`checked="indeterminate"` → `aria-checked="mixed"`). Checked
 * fills with inverse ink, matching the primary button. Pair it with a `Label` (via a
 * shared `id`) or pass an `aria-label` for an accessible name.
 */
export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "group inline-flex size-[18px] shrink-0 items-center justify-center rounded-control",
      "border border-strong bg-surface text-fg-on-inverse",
      "outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
      "transition-[background-color,box-shadow] duration-[var(--wh-dur-instant)] ease-[var(--wh-ease-swift)]",
      "data-[state=checked]:border-transparent data-[state=checked]:bg-surface-inverse",
      "data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-surface-inverse",
      "disabled:cursor-not-allowed disabled:opacity-45",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="hidden size-3.5 group-data-[state=checked]:block"
      >
        <path
          d="m5 12 5 5L19 7"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="hidden size-3.5 group-data-[state=indeterminate]:block"
      >
        <path d="M6 12h12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";
