import * as React from "react";

import { cn } from "../lib/cn";
import { Mark, Wordmark } from "./mark";

export interface AuthShellProps {
  /** The sign-in form content, rendered in a centered, max-width card. */
  children: React.ReactNode;
  /** Top-bar right slot, opposite the lockup — typically a {@link ThemeToggle}. */
  actions?: React.ReactNode;
  /** Content below the form card, e.g. legal/terms copy. */
  footer?: React.ReactNode;
  /** Decorative visual-pane content (a brand quote, stats…). When omitted the shell is a single column. */
  visual?: React.ReactNode;
  /** Which side the visual pane sits on at ≥880px. Defaults to the right. */
  side?: "left" | "right";
  /** When set, the lockup links to this href (the brand "home"). */
  homeHref?: string;
  className?: string;
}

/**
 * The two-pane sign-in layout: a form pane (lockup + a centered form card) beside a
 * decorative brand visual that collapses away below 880px, leaving the form full-width.
 * The visual pane is `aria-hidden` — assistive tech sees only the form. Compose the actual
 * providers/magic-link form as `children`; pass the brand copy as `visual`.
 */
export function AuthShell({
  children,
  actions,
  footer,
  visual,
  side = "right",
  homeHref,
  className,
}: AuthShellProps) {
  const lockup = homeHref ? (
    <a href={homeHref} aria-label="webhook.co home" className="inline-flex w-fit">
      <Wordmark />
    </a>
  ) : (
    <Wordmark />
  );

  return (
    <div
      data-side={side}
      className={cn(
        "grid min-h-[100dvh] grid-cols-1",
        visual ? "min-[880px]:grid-cols-[1fr_1.06fr]" : "",
        className,
      )}
    >
      <main
        className={cn(
          "flex min-w-0 flex-col p-[clamp(22px,3.4vw,40px)]",
          side === "left" ? "min-[880px]:order-2" : "",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          {lockup}
          {actions}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-[22px] py-8">
          <div className="w-full max-w-[366px]">{children}</div>
          {footer ? <div className="w-full max-w-[366px]">{footer}</div> : null}
        </div>
      </main>

      {visual ? (
        <aside
          aria-hidden="true"
          className={cn(
            "relative m-3 hidden overflow-hidden rounded-card bg-surface-inverse p-12 text-fg-on-inverse min-[880px]:block",
            side === "left" ? "min-[880px]:order-1" : "",
          )}
        >
          <Mark
            size={360}
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-16 -right-16 opacity-[0.05]"
          />
          <div className="relative flex h-full flex-col justify-end">{visual}</div>
        </aside>
      ) : null}
    </div>
  );
}
AuthShell.displayName = "AuthShell";
