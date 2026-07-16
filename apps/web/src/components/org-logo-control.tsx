"use client";

import { Banner, Button } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

import { removeOrgLogo, uploadOrgLogoWebp } from "@/lib/avatar-upload";
import { orgLogoVersion } from "@/lib/org-logo-version";

import { AvatarCropperDialog } from "./avatar-cropper";
import { OrgAvatar } from "./org-avatar";

export interface OrgLogoControlProps {
  readonly slug: string;
  readonly name: string;
  /** Whether the org currently has an uploaded logo — drives the Remove control. */
  readonly hasLogo: boolean;
  /** Owner/admin only; a plain member sees the logo read-only (the server re-checks regardless). */
  readonly canManage: boolean;
}

/**
 * The org logo + its Change/Remove controls — the CONTROL only, with no Card of its own.
 *
 * It used to be a whole card ("Logo") stacked under "Organization", which read as a second, separate thing to
 * configure when it is simply part of what an organization IS — alongside its name and its URL. Extracting the
 * control lets the settings page put it beside those fields instead of below them.
 *
 * MUST NOT be rendered inside a `<form>`: its buttons carry no `type`, so inside one they would default to
 * `submit` and fire the rename. The settings card deliberately places this as a sibling of the form, in the
 * adjacent column — which also matches the semantics, since uploading is its own immediate action and is not
 * part of "Save changes".
 */
export function OrgLogoControl({ slug, name, hasLogo, canManage }: OrgLogoControlProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = React.useCallback(
    (blob: Blob, opts: { signal?: AbortSignal }) =>
      uploadOrgLogoWebp(blob, { slug, signal: opts.signal }),
    [slug],
  );

  function onUploaded() {
    setOpen(false);
    orgLogoVersion.bump(); // refreshes every OrgAvatar on the page (this one + the switcher)
    router.refresh(); // re-reads the server, so Remove appears/disappears
  }

  async function onRemove() {
    setRemoving(true);
    setError(null);
    const res = await removeOrgLogo(slug);
    setRemoving(false);
    if (res.ok) {
      orgLogoVersion.bump();
      router.refresh();
    } else {
      setError(res.error);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <OrgAvatar name={name} slug={slug} size={72} />
      {canManage ? (
        <div className="flex flex-col items-start gap-1">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {hasLogo ? "Change logo" : "Upload logo"}
          </Button>
          {hasLogo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              loading={removing}
              disabled={removing}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <AvatarCropperDialog
        open={open}
        onOpenChange={setOpen}
        onUploaded={onUploaded}
        upload={upload}
        title="Change organization logo"
        description="Upload a square-ish image, then drag and zoom to frame it."
        cropShape="rect"
      />
    </div>
  );
}
