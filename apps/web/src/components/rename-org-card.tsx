"use client";

import {
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
} from "@webhook-co/ui";
import { orgSlugErrorMessage, validateOrgSlug } from "@webhook-co/shared";
import { useState, useTransition } from "react";

import { OrgLogoControl } from "./org-logo-control";

import type { RenameOrgResult } from "@/server/org-actions";

/**
 * Live copy for a slug: the confirming hint when it's valid, or the SAME per-reason message the server uses
 * (`orgSlugErrorMessage`) when it isn't — one source, so the client and server never disagree on wording.
 */
function slugHint(slug: string, current: string): { error?: string; hint?: string } {
  if (slug === current) return {};
  const res = validateOrgSlug(slug);
  if (res.ok) return { hint: `Your team will live at webhook.co/org/${slug}` };
  return { error: orgSlugErrorMessage(res.reason) };
}

export interface RenameOrgCardProps {
  readonly slug: string;
  readonly name: string;
  /** The rename action, pre-bound to the current slug by the page. */
  readonly rename: (formData: FormData) => Promise<RenameOrgResult>;
  /** Whether the caller may rename at all (owner/admin). A member sees the card read-only. */
  readonly canRename: boolean;
  /** Whether the org currently has an uploaded logo — drives the logo column's Remove control. */
  readonly hasLogo: boolean;
}

/**
 * The org's identity: its logo, its display name, and its URL slug — one section, because they are one thing.
 *
 * The logo used to be a whole separate card stacked underneath, which read as a second thing to configure
 * rather than part of what the organization IS. It now sits in a narrow column beside the fields it belongs
 * with. It is a SIBLING of the <form>, not inside it: the logo uploads immediately (it is not part of "Save
 * changes"), and its buttons would otherwise default to `type="submit"` and fire the rename.
 *
 * The slug is validated LIVE with the same `validateOrgSlug` the server and the DB use, so the user knows
 * before submitting; the server re-validates and the DB is the final authority (a slug taken by another org,
 * live or retired, comes back as an inline error). Renaming the slug retires the old URL — which keeps
 * redirecting — so we say so plainly.
 *
 * A plain member sees the current values but cannot edit: renaming changes the org's public address and
 * retires the old one forever, so it is owner/admin only, enforced server-side in `renameOrg`.
 */
export function RenameOrgCard({ slug, name, rename, canRename, hasLogo }: RenameOrgCardProps) {
  const [nameValue, setNameValue] = useState(name);
  const [slugValue, setSlugValue] = useState(slug);
  const [serverError, setServerError] = useState<string | null>(null);
  // The logo control's failures surface HERE, full-width below both columns — see OrgLogoControl.onError.
  const [logoError, setLogoError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const { error: slugError, hint: slugHintText } = slugHint(slugValue, slug);
  const nothingChanged = nameValue.trim() === name && slugValue === slug;
  const canSubmit =
    canRename && !pending && !nothingChanged && nameValue.trim().length > 0 && !slugError;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setServerError(null);
    const fd = new FormData();
    fd.set("name", nameValue.trim());
    fd.set("slug", slugValue);
    startTransition(async () => {
      // On success the action redirects (throws), so control does not return here. A returned result is an
      // error to render inline — most often a slug the DB says is taken.
      const res = await rename(fd);
      if (res && !res.ok) setServerError(res.error);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          {canRename
            ? "Your organization's logo, name, and URL. Renaming the URL keeps the old one working — links to it keep resolving."
            : "Your organization's logo, name, and URL. Only an owner or admin can change these."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Narrow logo column, wide fields column — stacked on a narrow viewport so the fields never get
            squeezed to a sliver beside a 72px tile. */}
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          <div className="shrink-0">
            <OrgLogoControl
              slug={slug}
              name={name}
              hasLogo={hasLogo}
              canManage={canRename}
              onError={setLogoError}
            />
          </div>
          <form onSubmit={onSubmit} className="flex min-w-0 flex-1 flex-col gap-4">
            <Field
              label="Name"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              disabled={!canRename || pending}
              maxLength={100}
            />
            <Field
              label="URL"
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value.toLowerCase())}
              disabled={!canRename || pending}
              hint={slugHintText ?? `webhook.co/org/${slug}`}
              error={slugError}
              spellCheck={false}
              autoCapitalize="none"
            />
            {serverError ? <Banner tone="danger">{serverError}</Banner> : null}
            {canRename ? (
              <div className="flex justify-end">
                <Button type="submit" loading={pending} disabled={!canSubmit}>
                  Save changes
                </Button>
              </div>
            ) : null}
          </form>
        </div>
        {logoError ? (
          <div className="mt-4">
            <Banner tone="danger">{logoError}</Banner>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
