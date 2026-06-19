import * as React from "react";

import { cn } from "../lib/cn";
import { Wordmark } from "./mark";

export interface AppShellProps {
  /** The page content, rendered in the scrollable main canvas. */
  children: React.ReactNode;
  /** The primary nav — compose with `AppNavSection` + `AppNavItem`. */
  sidebar: React.ReactNode;
  /** The top bar (breadcrumbs + actions). Omit to drop the header entirely. */
  topBar?: React.ReactNode;
  /** Below the lockup, above the nav — e.g. a workspace switcher. */
  sidebarTop?: React.ReactNode;
  /** Pinned to the sidebar bottom — e.g. the account button. */
  sidebarFooter?: React.ReactNode;
  /** When set, the lockup links to this href. */
  homeHref?: string;
  className?: string;
}

/**
 * The dashboard frame: a fixed sidebar (lockup → optional workspace switcher → scrolling
 * nav → optional account footer) beside a main column (an optional sticky top bar over the
 * scrollable canvas). Landmarks are wired — `nav`, `banner`, and `main` — so the page is
 * navigable by assistive tech.
 *
 * Desktop-first: the sidebar shows at `md`+ and is hidden below it. A mobile nav affordance
 * (a drawer toggled from the top bar) is intentionally out of v1 — wire it in the consuming
 * dashboard, where the toggle state and focus management live.
 */
export function AppShell({
  children,
  sidebar,
  topBar,
  sidebarTop,
  sidebarFooter,
  homeHref,
  className,
}: AppShellProps) {
  const lockup = homeHref ? (
    <a href={homeHref} aria-label="webhook.co home" className="inline-flex w-fit">
      <Wordmark markSize={26} />
    </a>
  ) : (
    <Wordmark markSize={26} />
  );

  return (
    <div
      className={cn(
        "grid h-[100dvh] w-full grid-cols-1 overflow-hidden bg-surface-page md:grid-cols-[252px_1fr]",
        className,
      )}
    >
      <aside className="hidden min-h-0 flex-col overflow-hidden border-r border-hairline bg-surface md:flex">
        <div className="flex h-[60px] flex-shrink-0 items-center px-4">{lockup}</div>
        {sidebarTop ? <div className="px-3 pb-2">{sidebarTop}</div> : null}
        <nav
          aria-label="Primary"
          className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-1"
        >
          {sidebar}
        </nav>
        {sidebarFooter ? (
          <div className="mt-auto border-t border-hairline p-3">{sidebarFooter}</div>
        ) : null}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {topBar ? (
          <header className="flex h-[60px] flex-shrink-0 items-center gap-3 border-b border-hairline bg-surface px-4">
            {topBar}
          </header>
        ) : null}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
AppShell.displayName = "AppShell";

export interface AppNavItemProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Leading icon (sized to 18px). */
  icon?: React.ReactNode;
  /** Trailing count pill (e.g. an endpoint or event total). */
  count?: React.ReactNode;
  /** Marks the current page — sets `aria-current` and the active treatment. */
  active?: boolean;
}

/**
 * A sidebar nav link: leading icon, label, optional trailing count pill. The active item
 * carries `aria-current="page"`, an inverse-ink left rail, and a sunken fill.
 */
export const AppNavItem = React.forwardRef<HTMLAnchorElement, AppNavItemProps>(
  ({ icon, count, active, className, children, ...props }, ref) => (
    <a
      ref={ref}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 items-center gap-2.5 rounded-control px-2.5 text-base text-fg-secondary",
        "transition-colors hover:bg-surface-sunken hover:text-fg",
        "outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
        "[&_svg]:size-[18px] [&_svg]:shrink-0",
        active &&
          "bg-surface-sunken font-semibold text-fg before:absolute before:bottom-2 before:left-[-12px] before:top-2 before:w-[3px] before:rounded-r-[3px] before:bg-fg before:content-['']",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {count != null ? (
        <span className="ml-auto rounded-pill border border-hairline bg-surface-sunken px-1.5 py-px font-mono text-[11px] tabular-nums text-fg-faint">
          {count}
        </span>
      ) : null}
    </a>
  ),
);
AppNavItem.displayName = "AppNavItem";

/** A small uppercase label that groups sidebar nav items (e.g. "Workspace", "Account"). */
export function AppNavSection({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "px-2.5 pb-1.5 pt-3.5 font-mono text-[10px] uppercase tracking-mono-label text-fg-faint",
        className,
      )}
      {...props}
    />
  );
}
