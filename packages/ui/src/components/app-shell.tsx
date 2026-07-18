import { Slot } from "@radix-ui/react-slot";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";

import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";
import { Wordmark } from "./mark";

// The nav's list-reset + column rhythm, defined ONCE. This is the crux of the nested-list nav: the same
// `list-none m-0 p-0` reset and `gap-0.5` between-item rhythm must hold on every list level (top list, each
// section's list, the Events sub-list) and every list item, or the sidebar's spacing drifts and a stray
// bullet/margin creeps back in on one level. Four verbatim copies of this string used to invite exactly that.
//   - NAV_LIST_RESET: strips the list marker/margin/padding (Tailwind's own reset already does this; we state
//     it so nothing downstream reintroduces it). Used on the plain item `<li>`.
//   - NAV_LIST: the reset plus the flex column + 2px gap. Used on every `<ul>` and on a section's grouping
//     `<li>`. Kept as the prettier-tailwind-sorted literal so the emitted className is byte-for-byte unchanged.
const NAV_LIST_RESET = "m-0 list-none p-0";
const NAV_LIST = "m-0 flex list-none flex-col gap-0.5 p-0";

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
  // The lockup is now OPTIONAL, and the dashboard opts out.
  //
  // Every modern SaaS sidebar (Vercel, Resend, Linear) puts the ORG PICKER in the top-left corner — it is the
  // first thing you look at, because "which workspace am I in?" is the question you need answered before any
  // other. A wordmark there answers a question nobody was asking: the user knows what site they are on. So the
  // dashboard hands `sidebarTop` the picker and passes no `homeHref`, and the picker takes the corner.
  //
  // Kept as a prop rather than deleted because the shell is a generic primitive; a surface that DOES want a
  // wordmark still can.
  const lockup = homeHref ? (
    <div className="flex h-[3.75rem] flex-shrink-0 items-center px-4">
      <a href={homeHref} aria-label="webhook.co home" className="inline-flex w-fit">
        <Wordmark markSize={26} />
      </a>
    </div>
  ) : null;

  // The sidebar contents are shared by the fixed desktop rail and the mobile drawer; only
  // one of the two is ever visible (the desktop rail is `display:none` below `md`), so the
  // single "Primary" nav landmark is never duplicated in the accessibility tree.
  const sidebarBody = (
    <>
      {lockup}
      {/* `pt-3` when there is no lockup above it, so the picker sits in the corner with breathing room rather
          than jammed against the top edge. */}
      {sidebarTop ? (
        <div className={cn("flex-shrink-0 px-3 pb-2", homeHref ? undefined : "pt-3")}>
          {sidebarTop}
        </div>
      ) : null}
      <nav aria-label="Primary" className="flex flex-1 flex-col overflow-y-auto px-3 py-1">
        {/* A real list — the nav is a list of destinations, so it says so. `role="list"` is explicit because
            the `list-style:none` reset below strips list semantics in Safari+VoiceOver; without the role they
            drop the list entirely. The flex column + `gap-0.5` rhythm that used to live on the <nav> moves
            here, onto the list, so the visual layout is unchanged. Sections and sub-items nest as real child
            lists (see AppNavSection / AppNavItem). */}
        <ul role="list" className={NAV_LIST}>
          {sidebar}
        </ul>
      </nav>
      {sidebarFooter ? (
        <div className="mt-auto flex-shrink-0 border-t border-hairline p-3">{sidebarFooter}</div>
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
          <header className="flex h-[3.75rem] flex-shrink-0 items-center gap-3 border-b border-hairline bg-surface px-4">
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
  /**
   * Applies the SUB-item visual treatment to this item's anchor: indented to where a top-level item's label
   * starts (past the icon), and without its own icon.
   *
   * This is styling only — the parent/child RELATIONSHIP is expressed structurally, via the parent item's
   * `subNav` (a nested `<ul role="list">` inside the parent's own `<li>`), so assistive tech announces a
   * sub-item as a real child. The indent lives on the anchor (not the nested list) deliberately: it keeps the
   * sub-item's anchor full-width, so its hover/active fill spans the rail exactly as a top-level item's does
   * while only the label shifts right.
   */
  nested?: boolean;
  /**
   * Sub-items this entry owns. Rendered in a nested `<ul role="list">` as a sibling of the anchor inside this
   * item's own `<li>` — so they are true DOM children and are announced as such. Each child should itself be
   * an `<AppNavItem nested>` (which supplies the sub-item indent and drops the icon).
   */
  subNav?: React.ReactNode;
  /**
   * Render the child element instead of a bare `<a>`, keeping the nav styling. This is how a router link
   * (next/link) gets in: without it the sidebar emits plain anchors and every click is a FULL DOCUMENT
   * NAVIGATION — the whole app shell torn down and re-fetched on each nav.
   */
  asChild?: boolean;
}

/**
 * A sidebar nav link: leading icon, label, optional trailing count pill. The active item
 * carries `aria-current="page"`, an inverse-ink left rail, and a sunken fill.
 */
export const AppNavItem = React.forwardRef<HTMLAnchorElement, AppNavItemProps>(
  (
    { icon, count, active, nested = false, asChild = false, subNav, className, children, ...props },
    ref,
  ) => {
    const navClass = cn(
      "relative flex h-9 items-center gap-2.5 rounded-control px-2.5 text-base text-fg-secondary",
      // Sub-items sit a clear step deeper than a top-level label — indented well past the "└" tree connector
      // drawn in their gutter (see `contents`) so the parent→child relationship reads at a glance and the item
      // looks tucked UNDER its parent, not beside it. The connector's horizontal reach tracks this indent.
      nested && "pl-[3.25rem]",
      "transition-colors hover:bg-surface-sunken hover:text-fg",
      "outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
      "[&_svg]:size-[1.125rem] [&_svg]:shrink-0",
      active &&
        "bg-surface-sunken font-semibold text-fg before:absolute before:bottom-2 before:left-[-12px] before:top-2 before:w-[3px] before:rounded-r-[3px] before:bg-fg before:content-['']",
      className,
    );

    /** The item's contents: an optional sub-item connector, leading icon, the label, then the count pill. */
    const contents = (label: React.ReactNode) => (
      <>
        {/* A decorative "└" tree connector for a sub-item: a short left+bottom border with a rounded elbow,
            drawn in the gutter beneath the parent's icon so the nesting is SHOWN, not merely announced. It is
            aria-hidden and pointer-events-none — pure ornament, since the DOM already carries the parent→child
            relationship (see `subNav`). Absolutely positioned, so it never disturbs the flex row; the anchor's
            `nested` left-padding leaves room for it. `border-strong` is the one separator step above the faint
            hairline, so the line is visible without competing with the label. */}
        {nested ? (
          <span
            aria-hidden="true"
            data-nav-connector=""
            className="pointer-events-none absolute left-5 top-0 h-1/2 w-4 rounded-bl-[6px] border-b border-l border-strong"
          />
        ) : null}
        {icon}
        <span className="flex-1 truncate">{label}</span>
        {count != null ? (
          <>
            {/* Left as-is, the pill fuses into the link's accessible name ("Endpoints3"). So the VISUAL pill
                is hidden from assistive tech and the count is announced as its own clause — "Endpoints, 3".
                The number is still conveyed, just not glued onto the page name. */}
            <span
              aria-hidden="true"
              className="ml-auto rounded-pill border border-hairline bg-surface-sunken px-1.5 py-px font-mono text-[0.6875rem] tabular-nums text-fg-faint"
            >
              {count}
            </span>
            <span className="sr-only">{`, ${String(count)}`}</span>
          </>
        ) : null}
      </>
    );

    // asChild: the caller's element (a router link) BECOMES the anchor. Slot merges our className +
    // aria-current onto it, and we re-parent the icon/label/count INSIDE it — so the anchor the router
    // controls is the same anchor the user clicks. Wrapping it instead would nest <a> inside <a> (invalid,
    // and it would defeat the router).
    const child = React.isValidElement(children)
      ? (children as React.ReactElement<{ children?: React.ReactNode }>)
      : null;
    const anchor =
      asChild && child ? (
        <Slot ref={ref} aria-current={active ? "page" : undefined} className={navClass} {...props}>
          {React.cloneElement(child, undefined, contents(child.props.children))}
        </Slot>
      ) : (
        <a ref={ref} aria-current={active ? "page" : undefined} className={navClass} {...props}>
          {contents(children)}
        </a>
      );

    // Every item is a real list item. When it owns sub-items, they hang off a nested `<ul role="list">`
    // that is a sibling of the anchor INSIDE this same `<li>` — a true DOM child, so the hierarchy is
    // announced, not merely drawn. `flex flex-col gap-0.5` on the <li> reproduces the exact 2px rhythm the
    // sub-item had as a flat sibling; the sub-list itself carries no indent (that lives on the anchor, via
    // `nested`), so the sub-item's fill stays full-width.
    return (
      <li className={cn(NAV_LIST_RESET, subNav != null && "flex flex-col gap-0.5")}>
        {anchor}
        {subNav != null ? (
          <ul role="list" className={NAV_LIST}>
            {subNav}
          </ul>
        ) : null}
      </li>
    );
  },
);
AppNavItem.displayName = "AppNavItem";

export interface AppNavSectionProps {
  /** The section label (e.g. "Inbound", "Account"). */
  label: React.ReactNode;
  /** The section's nav items — each an `<AppNavItem>` (which renders its own `<li>`). */
  children: React.ReactNode;
  /** Extra classes on the label element. */
  className?: string;
}

/**
 * A named group of sidebar nav items. It is a real, LABELED group now — not a decorative heading floating
 * above unrelated siblings: the section renders a `<li>` holding its label plus a nested
 * `<ul role="list" aria-labelledby={label}>`, so the section name is programmatically tied to the items it
 * introduces. The label keeps its exact small-uppercase styling, and the `pt-3.5 pb-1.5` + `gap-0.5` rhythm
 * is preserved, so the grouping is invisible to the eye and audible to a screen reader.
 */
export function AppNavSection({ label, children, className }: AppNavSectionProps) {
  const labelId = React.useId();
  return (
    <li className={NAV_LIST}>
      <p
        id={labelId}
        className={cn(
          "px-2.5 pb-1.5 pt-3.5 font-mono text-[0.625rem] uppercase tracking-mono-label text-fg-faint",
          className,
        )}
      >
        {label}
      </p>
      <ul role="list" aria-labelledby={labelId} className={NAV_LIST}>
        {children}
      </ul>
    </li>
  );
}
