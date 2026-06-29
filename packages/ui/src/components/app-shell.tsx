import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";

import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";
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
  /**
   * Controlled open state for the mobile nav drawer (below `md`). Drive it from a hamburger
   * in `topBar` that is itself `md:hidden` — Radix focus-traps and scroll-locks whenever this
   * is `true`, so opening it at `md`+ would trap focus in the off-screen drawer. The drawer
   * closes on Escape, outside-click, or its close button.
   */
  sidebarOpen?: boolean;
  /** Called when the mobile drawer requests open/close (Escape, outside-click, hamburger). */
  onSidebarOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * The dashboard frame: a fixed sidebar (lockup → optional workspace switcher → scrolling
 * nav → optional account footer) beside a main column (an optional sticky top bar over the
 * scrollable canvas). Landmarks are wired — `nav`, `banner`, and `main` — so the page is
 * navigable by assistive tech.
 *
 * The sidebar is fixed at `md`+. Below `md` it collapses into a controlled, focus-trapped
 * drawer (`sidebarOpen` / `onSidebarOpenChange`) — drive it from a hamburger in `topBar`.
 */
export function AppShell({
  children,
  sidebar,
  topBar,
  sidebarTop,
  sidebarFooter,
  homeHref,
  sidebarOpen,
  onSidebarOpenChange,
  className,
}: AppShellProps) {
  const lockup = homeHref ? (
    <a href={homeHref} aria-label="webhook.co home" className="inline-flex w-fit">
      <Wordmark markSize={26} />
    </a>
  ) : (
    <Wordmark markSize={26} />
  );

  // The sidebar contents are shared by the fixed desktop rail and the mobile drawer; only
  // one of the two is ever visible (the desktop rail is `display:none` below `md`), so the
  // single "Primary" nav landmark is never duplicated in the accessibility tree.
  const sidebarBody = (
    <>
      <div className="flex h-[60px] flex-shrink-0 items-center px-4">{lockup}</div>
      {sidebarTop ? <div className="px-3 pb-2">{sidebarTop}</div> : null}
      <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-1">
        {sidebar}
      </nav>
      {sidebarFooter ? (
        <div className="mt-auto border-t border-hairline p-3">{sidebarFooter}</div>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        // A FIXED frame, sized to the DYNAMIC viewport (`h-[100dvh]`), not an in-flow block. Two reasons:
        // (1) an in-flow viewport-height element with a nested tall scroll container (the <main> below)
        // makes the document itself gain phantom scroll height in Chrome, so a tall page over-scrolls past
        // the shell — `position: fixed` takes the frame out of flow and kills that. (2) `h-[100dvh]` (vs
        // `inset-0`, which would use the layout viewport) tracks the dynamic viewport, so on mobile Safari
        // the bottom of <main> isn't clipped behind the retracting toolbar. Only <main> scrolls.
        "fixed inset-x-0 top-0 h-[100dvh] grid grid-cols-1 overflow-hidden bg-surface-page md:grid-cols-[252px_1fr]",
        className,
      )}
    >
      <aside className="hidden min-h-0 flex-col overflow-hidden border-r border-hairline bg-surface md:flex">
        {sidebarBody}
      </aside>

      <DialogPrimitive.Root open={sidebarOpen} onOpenChange={onSidebarOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(9_11_16/0.55)] md:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col border-r border-hairline bg-surface outline-none md:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton
                aria-label="Close navigation"
                variant="ghost"
                size="sm"
                className="absolute right-3 top-3"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
                  <path
                    d="m6 6 12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            </DialogPrimitive.Close>
            {sidebarBody}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

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
