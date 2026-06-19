import * as React from "react";

import { cn } from "../lib/cn";

const sizeClass = { sm: "size-4", md: "size-5", lg: "size-6" } as const;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Visual size; inherits the current text color. */
  size?: keyof typeof sizeClass;
  /** Accessible name announced to assistive tech (defaults to "Loading"). */
  label?: string;
}

/**
 * An indeterminate loading indicator. Inherits color via `currentColor`, carries a
 * `status` role with an accessible name, and honors `prefers-reduced-motion` — the spin
 * stops, leaving a static ring (no motion forced on users who opted out). The spinner only
 * signals "in progress"; the calling flow owns announcing completion/error.
 */
export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ size = "md", label = "Loading", className, ...props }, ref) => {
    return (
      <span
        ref={ref}
        role="status"
        aria-label={label}
        className={cn("inline-flex text-current", sizeClass[size], className)}
        {...props}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="size-full animate-spin motion-reduce:animate-none"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="2.5"
            className="opacity-20"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  },
);
Spinner.displayName = "Spinner";
