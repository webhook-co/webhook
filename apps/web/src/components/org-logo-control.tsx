"use client";

import { Button } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

import { removeOrgLogo, uploadOrgLogoWebp } from "@/lib/avatar-upload";
import { orgLogoVersion } from "@/lib/org-logo-version";

import { AvatarCropperDialog } from "./avatar-cropper";
import { OrgAvatar } from "./org-avatar";

export interface OrgLogoControlProps {
  readonly slug: string;
  readonly name: string;
  /**
   * Where a failure is reported. The control does NOT render its own Banner: it lives in a `shrink-0` column
   * beside the identity fields, and a Banner's max-content width is the entire error sentence — so rendering
   * one here widens that column to the width of "Only an owner or admin can change the logo." and squeezes
   * Name/URL into a sliver. The consumer surfaces it full-width, below both columns.
   */
  readonly onError: (message: string | null) => void;
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
 * Uploading is its own immediate action, not part of any surrounding "Save changes" — which is why
 * RenameOrgCard, its only consumer, renders this as a sibling of its <form> rather than inside it.
 */
export function OrgLogoControl({ slug, name, hasLogo, canManage, onError }: OrgLogoControlProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const upload = React.useCallback(
    (blob: Blob, opts: { signal?: AbortSignal }) =>
      uploadOrgLogoWebp(blob, { slug, signal: opts.signal }),
    [slug],
  );

  function onUploaded() {
    setOpen(false);
    // A success has to retract whatever we last reported. The error lives in the CONSUMER (see onError), and
    // router.refresh() re-reads the server without resetting client state — so nothing else clears it, and a
    // failed Remove would leave a red banner sitting under the new logo the user can plainly see.
    onError(null);
    orgLogoVersion.bump(); // refreshes every OrgAvatar on the page (this one + the switcher)
    router.refresh(); // re-reads the server, so Remove appears/disappears
  }

  async function onRemove() {
    setRemoving(true);
    onError(null);
    const res = await removeOrgLogo(slug);
    setRemoving(false);
    if (res.ok) {
      orgLogoVersion.bump();
      router.refresh();
    } else {
      onError(res.error);
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
