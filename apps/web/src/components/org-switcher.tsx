"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@webhook-co/ui";
import Link from "next/link";
import * as React from "react";

import { OrgAvatar } from "./org-avatar";

type Org = { readonly orgId: string; readonly slug: string; readonly name: string };

export interface OrgSwitcherProps {
  readonly orgs: readonly Org[];
  readonly currentOrgId: string;
  /**
   * The acting org's name and slug, from the GATE (`requireOrgAccess`) rather than from `orgs`.
   *
   * These are passed separately on purpose. `loadMyOrgs` degrades to an empty list if its read blips (the
   * shell must never fail to render because the picker's query hiccuped) — and if the trigger derived its
   * label from that list, a blip would blank out the one label that must always be right: the org you are
   * looking at. The gate already knows it, and the gate cannot blip, because the page would not have rendered.
   */
  readonly currentName: string;
  readonly currentSlug: string;
}

const ChevronUpDown = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5 shrink-0">
    <path
      d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0">
    <path
      d="m3.5 8.5 3 3 6-7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Plus = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * The org picker, in the top-left corner of the sidebar — the standard place, and the first thing you look at,
 * because "which organization am I in?" is the question you need answered before any other.
 *
 * ── It ALWAYS renders, even with one org ────────────────────────────────────────────────────────────────
 *
 * The previous version hid itself below two orgs, on the reasoning that a picker with a single option is
 * noise. That reasoning had it backwards. Most users have exactly one org — so for the overwhelming majority
 * of people, the control that tells you WHICH org you are acting in was invisible, and the only way to make a
 * second one was a small text link they had to notice. Showing the current org is not noise; it is the label
 * on the workspace, and it is what makes "create another" a discoverable next step instead of a hidden one.
 *
 * ── Switching is a NAVIGATION, not a mutation — and that is load-bearing ────────────────────────────────
 *
 * Each entry is a `next/link` to `/org/{slug}/dashboard`. It does NOT re-mint the session cookie onto a new
 * org, and it must never be "improved" into doing so (ADR-0117). That cookie write was the single most
 * security-sensitive mutation in the product, and it existed purely to serve this picker — one cookie per
 * browser meant switching here silently retargeted every OTHER open tab's writes: tab A still showing Alpha
 * would create its next endpoint in Beta. The org lives in the URL now, so `/org/alpha/…` and `/org/beta/…`
 * are different Router-Cache keys that cannot alias, other tabs are untouched, and Back lands on the org you
 * were actually looking at.
 *
 * It lands on the new org's OVERVIEW rather than the equivalent page, deliberately: the current page may name
 * a resource (an endpoint, an event) that does not exist over there, and a switcher that 404s you is worse
 * than one that takes a beat.
 */
export function OrgSwitcher({ orgs, currentOrgId, currentName, currentSlug }: OrgSwitcherProps) {
  // The directory read can degrade to [] on a blip. Fall back to the org the gate already proved, so the
  // picker still names where you are — it just cannot offer to move you anywhere else this render.
  const options: readonly Org[] =
    orgs.length > 0 ? orgs : [{ orgId: currentOrgId, slug: currentSlug, name: currentName }];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Organization: ${currentName}. Switch organization`}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface-sunken focus-visible:shadow-[var(--wh-focus-ring)]"
      >
        <OrgAvatar name={currentName} size={22} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{currentName}</span>
        <span className="text-fg-faint">
          <ChevronUpDown />
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[228px]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>

        {options.map((org) => {
          const isCurrent = org.orgId === currentOrgId;
          return (
            <DropdownMenuItem key={org.orgId} asChild>
              <Link
                href={`/org/${org.slug}/dashboard`}
                className="flex items-center gap-2"
                // The current org is announced as such, not merely ticked — the checkmark is a visual, and a
                // screen-reader user would otherwise hear an identical list with nothing marking where I am.
                aria-current={isCurrent ? "true" : undefined}
              >
                <OrgAvatar name={org.name} size={20} />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                {isCurrent ? (
                  <span className="text-fg">
                    <Check />
                  </span>
                ) : null}
              </Link>
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        {/* Always present, and pinned to the bottom — the reference pattern, and the thing that makes a
            second org possible to create at all for the majority of users who have exactly one. */}
        <DropdownMenuItem asChild>
          <Link href="/org/new" className="flex items-center gap-2">
            <span className="text-fg-secondary">
              <Plus />
            </span>
            Create organization
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
