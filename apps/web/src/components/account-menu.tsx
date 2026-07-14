"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from "@webhook-co/ui";
import Link from "next/link";
import * as React from "react";

import { orgHref, useOrgSlug } from "@/lib/org-path";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const Dots = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="size-4 shrink-0">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

export interface AccountMenuProps {
  name: string;
  email: string;
  /** The logout server action, passed from the gated layout. */
  onLogout: () => void | Promise<void>;
}

/**
 * The signed-in user, pinned to the BOTTOM-LEFT of the sidebar — where Vercel, Resend and Linear all put it,
 * and where it belongs: "who am I signed in as" is a persistent fact about the session, not a page action, so
 * it lives with the shell rather than in the toolbar above the content.
 *
 * It used to be a bare initials circle in the top-right corner, which showed you nothing until you clicked it.
 * The name and email are now visible at rest.
 */
export function AccountMenu({ name, email, onLogout }: AccountMenuProps) {
  // The org this component is rendered in — read from the URL, which is the source of truth for it.
  const slug = useOrgSlug();

  // Logging out was the ONE action in the app with no feedback at all: `onSelect={() => onLogout()}` fired the
  // server action bare, outside any transition, so the menu closed and the page just sat there. And logout is
  // SLOW to *feel* — it is a cross-origin redirect through the auth issuer — so "nothing happened" is exactly
  // what it looked like, which is how you end up clicking it three times.
  const [signingOut, startSignOut] = React.useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${name}. Open account menu`}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface-sunken focus-visible:shadow-[var(--wh-focus-ring)]"
      >
        <span
          aria-hidden="true"
          className="grid size-[26px] shrink-0 place-items-center rounded-full border border-hairline bg-surface-sunken text-[0.625rem] font-medium text-fg-secondary"
        >
          {initials(name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{name}</span>
        {/* While the sign-out is in flight the trigger says so — the menu has already closed by then, so this
            is the only surface left that can tell the user their click landed. */}
        <span className="text-fg-faint">
          {signingOut ? <Spinner size="sm" label="Signing out" className="size-4" /> : <Dots />}
        </span>
      </DropdownMenuTrigger>

      {/* `side="top"`: the trigger sits at the very bottom of the viewport, so a menu opening downwards would
          open off-screen. */}
      <DropdownMenuContent side="top" align="start" className="w-[228px]">
        <DropdownMenuLabel className="font-sans normal-case tracking-normal">
          <span className="block truncate text-sm font-medium text-fg">{name}</span>
          <span className="block truncate text-xs text-fg-muted">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* The user-scoped `/account` surface (profile, connected apps, delete account) lands in the next
            slice; linking to it before it exists would just be a 404. */}
        <DropdownMenuItem asChild>
          <Link href={orgHref(slug, "/settings")}>Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          disabled={signingOut}
          // The menu CLOSES on select (deliberately not prevented — a modal menu left open would aria-hide the
          // very trigger we want to show the pending state on). So the spinner lives on the TRIGGER, which
          // survives the close, and the transition lives on this component, which survives both.
          onSelect={() => {
            // ASYNC, deliberately. A synchronous callback ends the transition the instant it returns, so
            // `signingOut` would flash true for one frame and vanish — which is EXACTLY the class of bug that
            // made "Sign in with Google" look like it did nothing. Awaiting the action is what keeps the
            // pending state alive for as long as the action actually takes.
            startSignOut(async () => {
              await onLogout();
            });
          }}
        >
          {signingOut ? "Signing out…" : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
