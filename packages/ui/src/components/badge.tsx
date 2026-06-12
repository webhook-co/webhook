import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Small label. `neutral` is the default monochrome chip; the functional tones
 * (`ok`/`warn`/`danger`/`info`) are the only colored variants and should be used to
 * carry state, never as decoration. For live delivery state prefer {@link StatusPill}.
 */
export const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5",
    "text-sm font-medium whitespace-nowrap",
  ],
  {
    variants: {
      tone: {
        neutral: "border-hairline bg-surface-sunken text-fg-secondary",
        ok: "border-ok-border bg-ok-bg text-ok",
        warn: "border-warn-border bg-warn-bg text-warn",
        danger: "border-danger-border bg-danger-bg text-danger",
        info: "border-info-border bg-info-bg text-info",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
