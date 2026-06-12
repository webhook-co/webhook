import * as React from "react";

import { cn } from "../lib/cn";

/**
 * The webhook.co mark — three continuous arcs at a confident 3.0 stroke (one cut at
 * every size, from the app icon down to the 16px favicon). Color follows
 * `currentColor`, so it inverts cleanly on dark surfaces.
 */
export interface MarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

export const Mark = React.forwardRef<SVGSVGElement, MarkProps>(
  ({ size = 24, className, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="webhook.co"
      className={className}
      {...props}
    >
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </svg>
  ),
);
Mark.displayName = "Mark";

export interface WordmarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Size of the leading mark in px. */
  markSize?: number;
  /** Hide the mark and render the wordmark alone. */
  hideMark?: boolean;
}

/**
 * The full lockup: the mark beside the wordmark. The name is always lowercase —
 * `webhook` in semibold, `.co` de-emphasized. Never "Webhook", never all-caps.
 */
export function Wordmark({ className, markSize = 22, hideMark = false, ...props }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-fg", className)} {...props}>
      {hideMark ? null : <Mark size={markSize} aria-hidden="true" />}
      <span className="text-xl font-semibold tracking-heading leading-none">
        webhook<span className="font-regular text-fg-muted">.co</span>
      </span>
    </span>
  );
}
