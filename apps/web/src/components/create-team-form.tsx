"use client";

import { Banner, Button, Card, CardContent, Field } from "@webhook-co/ui";
import { orgSlugErrorMessage, slugifyOrgName, validateOrgSlug } from "@webhook-co/shared";
import { useState, useTransition } from "react";

import type { CreateTeamResult } from "@/server/org-create-actions";

export interface CreateTeamFormProps {
  readonly create: (formData: FormData) => Promise<CreateTeamResult>;
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
export function CreateTeamForm({ create }: CreateTeamFormProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
      const res = await create(fd);
      if (res && !res.ok) setError(res.error);
    });
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={pending} disabled={!canSubmit}>
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
