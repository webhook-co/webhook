"use client";

import { Banner, Button, Card, CardContent, Field } from "@webhook-co/ui";
import { orgSlugErrorMessage, slugifyOrgName, validateOrgSlug } from "@webhook-co/shared";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { uploadOrgLogoWebp } from "@/lib/avatar-upload";
import { fileToDataUrl } from "@/lib/crop-image";
import type { CreateTeamResult, CreateTeamSlugResult } from "@/server/org-create-actions";

import { AvatarCropperDialog } from "./avatar-cropper";

// The org is already created by the time we upload the logo, so a slow upload must never trap the user here —
// bound it and navigate regardless. Generous: a 512×512 webp is tens of KB, so this only trips on a real stall.
const LOGO_UPLOAD_TIMEOUT_MS = 15_000;

export interface CreateTeamFormProps {
  readonly create: (formData: FormData) => Promise<CreateTeamResult>;
  /** The return-the-slug variant, used when a logo is chosen: the client uploads the cropped logo (which
   *  needs the new slug) then navigates. */
  readonly createReturningSlug: (formData: FormData) => Promise<CreateTeamSlugResult>;
}

/**
 * Create an organization from a name and, optionally, a chosen URL.
 *
 * The URL (slug) is the user's CHOICE, and it's only a choice once they touch the field. Until then the field
 * TRACKS the name as a live preview — and we do NOT send it: the name alone is enough to create an org, and the
 * server derives a valid, unique slug (with a random suffix). This is deliberate. Requiring the auto-derived
 * slug would regress the old name-only form: a name that slugifies to empty (e.g. non-Latin/emoji) or too-short
 * ("Hi", "42") would dead-end an otherwise valid name on a URL error the user never asked for. So:
 *
 *   • untouched field  → preview only; submit sends just the name; server derives the slug (always works).
 *   • touched field    → the user owns the URL; it's validated live and sent verbatim (a taken URL — live OR a
 *                        retired one, via the never-recycle guard — comes back as an inline error). Clearing it
 *                        hands the choice back to the server (same as untouched).
 *
 * On success the action redirects to the new org, so control never returns; a returned result is an error to
 * render inline.
 */
export function CreateTeamForm({ create, createReturningSlug }: CreateTeamFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The optional logo, cropped client-side into a square webp and held until the org exists — an org has no id
  // to key its R2 object at until it's created, so we upload AFTER create (see onSubmit). `logoPreview` is a
  // `data:` URL for the on-page preview (the CSP is `img-src 'self' data:`, so no `blob:` URL).
  const [logo, setLogo] = useState<Blob | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [cropperOpen, setCropperOpen] = useState(false);

  const captureLogo = useCallback(async (blob: Blob) => {
    setLogo(blob);
    setLogoPreview(await fileToDataUrl(blob));
    return { ok: true as const };
  }, []);

  const trimmed = name.trim();
  const trimmedSlug = slug.trim();
  // A slug is the user's CHOICE only when they've touched the field AND left something in it. An untouched
  // auto-derived value (or a cleared field) is not a choice — it must never block submit or show an error,
  // because the server will derive a valid unique slug from the name instead.
  const slugChosen = slugTouched && trimmedSlug.length > 0;
  // Validate the TRIMMED slug — that is exactly what onSubmit sends, so validating the raw value would block
  // submit on surrounding whitespace (easy on paste) that the server would have accepted.
  const slugCheck = slugChosen ? validateOrgSlug(trimmedSlug) : { ok: true as const };
  const slugError = slugChosen && !slugCheck.ok ? orgSlugErrorMessage(slugCheck.reason) : null;
  // The stem shown in the untouched-preview hint. Mirrors the server's derive-from-name fallback so the preview
  // matches what you'll actually get (server adds a short suffix to keep it unique).
  const previewBase = trimmed ? slugifyOrgName(trimmed) || "org" : "";

  function onName(next: string) {
    setName(next);
    // The URL follows the name until the user takes it over.
    if (!slugTouched) setSlug(slugifyOrgName(next));
  }

  // Block submit only on a name problem or a CHOSEN-but-invalid URL — never on an untouched derived value.
  const canSubmit = !!trimmed && !pending && !(slugChosen && !!slugError);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const fd = new FormData();
    fd.set("name", trimmed);
    // Send the URL ONLY when the user chose a valid one. Otherwise omit it so the server derives (and suffixes)
    // a valid unique slug from the name — the old, always-works behavior.
    if (slugChosen && !slugError) fd.set("orgSlug", trimmedSlug);
    startTransition(async () => {
      // No logo → the plain redirecting create (control never returns on success).
      if (!logo) {
        const res = await create(fd);
        if (res && !res.ok) setError(res.error);
        return;
      }
      // Logo → create returning the slug, upload the cropped logo to it, THEN navigate. A logo-upload failure
      // is not fatal: the org is created and the logo can still be added from settings, so we navigate anyway.
      const res = await createReturningSlug(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Bound the upload so a STALLED connection (accepted-but-never-answers) can't strand the user on this
      // form after the org already exists — uploadOrgLogoWebp resolves ok:false on abort (it never throws), so
      // on timeout we simply fall through and navigate, exactly as we do on any other upload failure.
      // The helper resolves ok:false on failure/abort rather than throwing, but the .catch is belt-and-braces:
      // nothing about a logo upload should be able to stop us from landing in the org that already exists.
      await uploadOrgLogoWebp(logo, {
        slug: res.slug,
        signal: AbortSignal.timeout(LOGO_UPLOAD_TIMEOUT_MS),
      }).catch(() => {});
      router.push(`/org/${res.slug}/dashboard?created=1`);
    });
  };

  return (
    <Card>
      {/* CardContent defaults to `pt-0` because it normally sits below a CardHeader that supplies the top
          padding. This card has NO header (the page h1 is the title), so restore the top padding — otherwise
          the first field's label is jammed against the card's top edge. twMerge lets pt-6 win over pt-0. */}
      <CardContent className="pt-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          {/* Logo left (narrow), identity right (wide) — the same shape as org settings, because it is the
              same thing: an organization IS its logo + name + URL, not a form with an attachment stapled
              underneath. Stacks on a narrow viewport so the fields never get squeezed beside the tile. */}
          <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
            <div className="flex shrink-0 flex-col items-start gap-3">
              {logoPreview ? (
                // A local data: URL preview (the cropped webp), not a remote src — a plain <img> is right here.
                <img
                  src={logoPreview}
                  alt=""
                  width={72}
                  height={72}
                  className="size-[4.5rem] rounded-[6px] border border-hairline object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="grid size-[4.5rem] place-items-center rounded-[6px] border border-dashed border-hairline text-2xl font-medium text-fg-faint"
                >
                  {trimmed ? trimmed[0]!.toUpperCase() : "?"}
                </div>
              )}
              <div className="flex flex-col items-start gap-1">
                <span className="text-xs text-fg-faint">Logo (optional)</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setCropperOpen(true)}
                    disabled={pending}
                  >
                    {logo ? "Change" : "Add logo"}
                  </Button>
                  {logo ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLogo(null);
                        setLogoPreview(null);
                      }}
                      disabled={pending}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <Field
                label="Organization name"
                placeholder="e.g. Acme Engineering"
                value={name}
                onChange={(e) => onName(e.target.value)}
                disabled={pending}
                maxLength={100}
                autoFocus
                hint="You can change the name and the URL later."
              />
              <Field
                label="Organization URL"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                disabled={pending}
                spellCheck={false}
                autoCapitalize="none"
                // The URL preview lives in the hint (the codebase pattern) — one source with the server's copy.
                // Chosen → the exact URL you'll get; untouched → the derived stem + a note that we keep it unique.
                hint={
                  slugError
                    ? undefined
                    : slugChosen
                      ? `Your organization will live at webhook.co/org/${trimmedSlug}`
                      : `Your URL will be webhook.co/org/${previewBase || "…"}${previewBase ? "-…" : ""} — edit to choose your own.`
                }
                error={slugError ?? undefined}
              />
            </div>
          </div>

          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={pending} disabled={!canSubmit}>
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </div>
        </form>

        {/* The shared cropper, with a blob-CAPTURING "upload" — at create-time there's no org yet to POST to,
            so we hold the cropped webp and upload it once the org exists (onSubmit). */}
        <AvatarCropperDialog
          open={cropperOpen}
          onOpenChange={setCropperOpen}
          onUploaded={() => setCropperOpen(false)}
          upload={captureLogo}
          title="Organization logo"
          description="Upload a square-ish image, then drag and zoom to frame it."
          cropShape="rect"
        />
      </CardContent>
    </Card>
  );
}
