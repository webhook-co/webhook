"use client";

import { Label, Select } from "@webhook-co/ui";
import * as React from "react";

type Org = { readonly orgId: string; readonly name: string; readonly role: string };

export interface OrgSwitcherProps {
  readonly orgs: readonly Org[];
  readonly currentOrgId: string;
  /** The server action. It re-checks membership and refuses anything the user isn't in. */
  readonly switchOrg: (formData: FormData) => Promise<void>;
}

/**
 * Pick which org the dashboard is acting as. Renders NOTHING when there's only one — most users have exactly
 * one org, and a picker with a single option is just noise in the sidebar.
 *
 * The selected org is only a request: `switchOrgAction` re-reads the user's memberships server-side and
 * refuses an org they don't belong to, and `requireOrgAccess` re-checks on every request after that. This
 * control is UX, not the gate.
 */
export function OrgSwitcher({ orgs, currentOrgId, switchOrg }: OrgSwitcherProps) {
  const [pending, startTransition] = React.useTransition();

  if (orgs.length <= 1) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="org-switcher" className="text-xs text-fg-secondary">
        Organization
      </Label>
      <Select
        id="org-switcher"
        value={currentOrgId}
        disabled={pending}
        onChange={(e) => {
          const fd = new FormData();
          fd.set("orgId", e.target.value);
          startTransition(() => {
            void switchOrg(fd);
          });
        }}
      >
        {orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>
            {o.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
