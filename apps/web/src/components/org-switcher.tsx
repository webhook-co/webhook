"use client";

import { Label, Select } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

type Org = { readonly orgId: string; readonly slug: string; readonly name: string };

export interface OrgSwitcherProps {
  readonly orgs: readonly Org[];
  readonly currentOrgId: string;
}

/**
 * Pick which org the dashboard is acting as. Renders NOTHING when there's only one — most users have exactly
 * one org, and a picker with a single option is just noise in the sidebar.
 *
 * 🔑 Switching is now a NAVIGATION, not a mutation. It used to submit a server action that re-minted the
 * session cookie onto the new org. Two things were wrong with that, and both disappear here:
 *
 *   * It was the ONLY code path in the product that mutated a session's org — the single most
 *     security-sensitive write we had — and it existed purely to serve a picker.
 *   * It made the switch INVISIBLE to the other tabs. With one cookie per browser, switching here silently
 *     retargeted every other open tab's writes: tab A still showing Alpha would create its next endpoint in
 *     Beta. That is the wrong-org write this whole lane exists to delete.
 *
 * Now the org is in the URL, so switching is just going somewhere else. `/org/alpha/…` and `/org/beta/…` are
 * different Router-Cache keys and cannot alias; other tabs are untouched; the back button lands on the org you
 * were actually looking at. And `requireOrgAccess` re-resolves the slug in your own directory on every request
 * afterwards — so this control is UX, and the gate is elsewhere, which is where a gate belongs.
 */
export function OrgSwitcher({ orgs, currentOrgId }: OrgSwitcherProps) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-1.5">
      {/* The picker only earns its space with more than one org — but "Create team" is ALWAYS here, so a
          single-org user can make a second one. (When it was hidden below the picker, the create page was
          unreachable for exactly the majority of users who have one org.) */}
      {orgs.length > 1 ? (
        <>
          <Label htmlFor="org-switcher" className="text-xs text-fg-secondary">
            Organization
          </Label>
          <Select
            id="org-switcher"
            value={currentOrgId}
            onChange={(e) => {
              const next = orgs.find((o) => o.orgId === e.target.value);
              // Land on the org's overview rather than the equivalent page in the new org: the current page
              // may name a resource (an endpoint, an event) that doesn't exist over there, and a switcher that
              // 404s you is worse than one that takes a beat.
              if (next) router.push(`/org/${next.slug}/dashboard`);
            }}
          >
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.name}
              </option>
            ))}
          </Select>
        </>
      ) : null}
      <a
        href="/org/new"
        className="text-xs text-fg-secondary underline-offset-4 hover:text-fg hover:underline"
      >
        + Create team
      </a>
    </div>
  );
}
