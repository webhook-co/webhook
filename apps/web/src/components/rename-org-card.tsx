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
}

/**
 * Rename the org — its display name and its URL slug.
 *
 * The slug is validated LIVE with the same `validateOrgSlug` the server and the DB use, so the user knows
 * before submitting; the server re-validates and the DB is the final authority (a slug taken by another org,
 * live or retired, comes back as an inline error). Renaming the slug retires the old URL — which keeps
 * redirecting — so we say so plainly.
 *
 * A plain member sees the current values but cannot edit: renaming changes the org's public address and
 * retires the old one forever, so it is owner/admin only, enforced server-side in `renameOrg`.
 */
export function RenameOrgCard({ slug, name, rename, canRename }: RenameOrgCardProps) {
  const [nameValue, setNameValue] = useState(name);
  const [slugValue, setSlugValue] = useState(slug);
  const [serverError, setServerError] = useState<string | null>(null);
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
            ? "Change your team's name and its URL. Renaming the URL keeps the old one working — links to it keep resolving."
            : "Your team's name and URL. Only an owner or admin can change these."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
  );
}
