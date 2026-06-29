import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Native select, styled to match the Input control surface (same height, border, radius, and focus
 * ring) so it sits flush beside text/date inputs in a filter row. Native on purpose — accessible by
 * default and zero JS; pass `<option>` children.
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          "flex h-[42px] w-full rounded-control border border-strong bg-surface px-3 text-base text-fg",
          "font-sans",
          "transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
          "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
          "disabled:opacity-45 disabled:pointer-events-none",
          className,
        )}
        {...props}
      />
    );
  },
);
Select.displayName = "Select";
