import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * The dashboard page frame. Until now every page under `(app)/` copied the same
 * `mx-auto flex max-w-[860px] flex-col gap-8 p-8` container by hand — 14 near-identical copies — and the
 * billing page shipped WITHOUT it, so it rendered edge-to-edge with no padding (the width bug). The shell's
 * `<main>` is deliberately bare (it is the sole scroll container), so page-level width + padding live here,
 * in one place, where they can't drift or be forgotten.
 */
export const pageContainerVariants = cva("mx-auto flex flex-col p-8", {
  variants: {
    // The reading measure. `default` (860px) is the list/detail width; `narrow` (760px) matches the old
    // settings pages. Kept as byte-identical Tailwind classes so migrating the existing pages is a pure
    // refactor with no visual change.
    size: {
      default: "max-w-[860px]",
      narrow: "max-w-[760px]",
    },
  },
  defaultVariants: { size: "default" },
});

export interface PageContainerProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof pageContainerVariants> {
  /** Vertical rhythm between page sections. Defaults to `gap-8`; billing-style pages pass `gap-6`. */
  readonly gap?: string;
}

export function PageContainer({ className, size, gap = "gap-8", ...props }: PageContainerProps) {
  return <div className={cn(pageContainerVariants({ size }), gap, className)} {...props} />;
}

export interface PageHeaderProps {
  readonly title: React.ReactNode;
  /** Sub-line under the title. Omitted → no paragraph is rendered (title-only header). */
  readonly description?: React.ReactNode;
  /** A back link rendered ABOVE the title (detail pages, e.g. `← Endpoints`). */
  readonly backHref?: string;
  readonly backLabel?: React.ReactNode;
  /** Right-aligned slot beside the title — a primary action (e.g. a Create button). */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/**
 * A page's title block. Covers the three shapes the dashboard used by hand: plain title + description (list
 * pages), title-only (settings), and a back-link above the title (detail pages) — plus an optional actions
 * slot. Normalizes the heading tracking so pages stop diverging (billing used `tracking-display`, others
 * `tracking-heading`).
 */
export function PageHeader({
  title,
  description,
  backHref,
  backLabel,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {backHref !== undefined && (
          <a
            href={backHref}
            className="text-sm text-fg-secondary underline-offset-2 hover:underline"
          >
            <span aria-hidden>← </span>
            {backLabel}
          </a>
        )}
        <h1 className="text-2xl font-semibold tracking-heading text-fg">{title}</h1>
        {description !== undefined && (
          <p className="leading-snug text-fg-secondary">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** A single primary CTA (e.g. "Send a test webhook") — the empty state IS the onboarding. */
  readonly action?: React.ReactNode;
  readonly className?: string;
}

/**
 * A standalone empty / zero-data state for a page or section. Distinct from `TableEmpty` (which renders a
 * `<td>` inside a table) — this drops anywhere. One CTA by design: the empty state is the onboarding step.
 */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-hairline bg-surface-sunken px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-base font-medium text-fg">{title}</p>
      {description !== undefined && (
        <p className="max-w-prose text-sm text-fg-secondary">{description}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
