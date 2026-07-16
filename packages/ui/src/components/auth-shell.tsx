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
  /**
   * Center the lockup ABOVE the form card instead of in the top-left bar. Used by onboarding, where the
   * lockup is the page's focal brand moment rather than a nav anchor. The top bar then carries only `actions`.
   */
  centerLockup?: boolean;
  /**
   * Horizontal placement of the top-bar lockup: `"left"` (default) or `"center"`. When `"center"`, the
   * lockup is centered in the bar and `actions` (the theme toggle) is pinned to the right — used by the
   * consent screen. Ignored when {@link centerLockup} moves the lockup above the form entirely.
   */
  logoAlign?: "left" | "center";
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
  centerLockup = false,
  logoAlign = "left",
  className,
}: AuthShellProps) {
  // Center-in-bar only applies when the lockup is IN the top bar (not moved above the form by centerLockup).
  const centerInBar = logoAlign === "center" && !centerLockup;
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
        {/* Top bar: the lockup sits here unless it is centered above the form (centerLockup), in which case
            only the actions (theme toggle) remain, right-aligned. With logoAlign="center" the lockup is
            centered in the bar and the actions are pinned to the right (absolute) so the lockup stays truly
            centered regardless of the actions' width. */}
        <div
          className={cn(
            "relative flex items-center gap-3",
            centerLockup ? "justify-end" : centerInBar ? "justify-center" : "justify-between",
          )}
        >
          {centerLockup ? null : lockup}
          {actions ? (
            centerInBar ? (
              // Out of flow so the lockup stays truly centered; vertically centered against it.
              <div className="absolute right-0 top-1/2 -translate-y-1/2">{actions}</div>
            ) : (
              actions
            )
          ) : null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-[22px] py-8">
          {centerLockup ? <div className="flex w-full justify-center">{lockup}</div> : null}
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
