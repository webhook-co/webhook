"use client";

import {
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

import { removeOrgLogo, uploadOrgLogoWebp } from "@/lib/avatar-upload";
import { orgLogoVersion } from "@/lib/org-logo-version";

import { AvatarCropperDialog } from "./avatar-cropper";
import { OrgAvatar } from "./org-avatar";

export interface LogoOrgCardProps {
  readonly slug: string;
  readonly name: string;
  /** Whether the org currently has an uploaded logo — drives the Remove control. */
  readonly hasLogo: boolean;
  /** Owner/admin only; a plain member sees the logo read-only (the server re-checks regardless). */
  readonly canManage: boolean;
}

/**
 * The org logo, on the settings page: the current logo (or the generated tile) with a Change / Remove control.
 * Uploading reuses the shared `AvatarCropperDialog` — same crop → 512×512 webp re-encode → same-origin POST —
 * pointed at the org's slug-scoped route. On success, `orgLogoVersion.bump()` refreshes every OrgAvatar on the
 * page (this card + the switcher) and `router.refresh()` re-reads the server (so Remove appears/disappears).
 */
export function LogoOrgCard({ slug, name, hasLogo, canManage }: LogoOrgCardProps) {
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
    orgLogoVersion.bump();
    router.refresh();
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
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>
          {canManage
            ? "A square image shown next to your organization. Only an owner or admin can change it."
            : "Your organization's logo. Only an owner or admin can change it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <OrgAvatar name={name} slug={slug} size={56} />
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setOpen(true)}>
                {hasLogo ? "Change logo" : "Upload logo"}
              </Button>
              {hasLogo ? (
                <Button variant="ghost" onClick={onRemove} loading={removing} disabled={removing}>
                  Remove
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {error ? (
          <div className="mt-3">
            <Banner tone="danger">{error}</Banner>
          </div>
        ) : null}
      </CardContent>

      <AvatarCropperDialog
        open={open}
        onOpenChange={setOpen}
        onUploaded={onUploaded}
        upload={upload}
        title="Change organization logo"
        description="Upload a square-ish image, then drag and zoom to frame it."
        cropShape="rect"
      />
    </Card>
  );
}
