"use client";

import { orgHref, useOrgSlug } from "@/lib/org-path";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@webhook-co/ui";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface AccountMenuProps {
  name: string;
  email: string;
  /** The logout server action, passed from the gated layout. */
  onLogout: () => void;
}

/**
 * The top-bar account control: an initials avatar opening a menu with the signed-in identity,
 * a link to settings, and log out. `onLogout` is the server action wired by the layout.
 */
export function AccountMenu({ name, email, onLogout }: AccountMenuProps) {
  // The org this component is rendered in — read from the URL, which is the source of truth for it.
  const slug = useOrgSlug();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="grid size-9 place-items-center rounded-full border border-hairline bg-surface-sunken text-sm font-medium text-fg-secondary outline-none transition-colors hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
      >
        {initials(name)}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="font-sans normal-case tracking-normal">
          <span className="block text-sm font-medium text-fg">{name}</span>
          <span className="block text-xs text-fg-muted">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={orgHref(slug, "/settings")}>Settings</a>
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => onLogout()}>
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
