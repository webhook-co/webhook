"use client";

import { Banner, Button, Card, CardContent, Field } from "@webhook-co/ui";
import { orgSlugErrorMessage, slugifyOrgName, validateOrgSlug } from "@webhook-co/shared";
import { useState, useTransition } from "react";

import type { CreateTeamResult } from "@/server/org-create-actions";

export interface CreateTeamFormProps {
  readonly create: (formData: FormData) => Promise<CreateTeamResult>;
}

/**
 * Create an organization from a name and a URL.
 *
 * The URL (slug) TRACKS the name as you type, but only until you touch the URL yourself — after that it is
 * yours and the name stops overwriting it (the same rule as onboarding; clobbering a hand-edited slug on the
 * next keystroke feels broken). Both are validated live for a friendly message; the server is still the
 * authority — a taken URL (live OR a retired one, via the never-recycle guard) comes back as an inline error.
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
  // Validate the TRIMMED slug — that is exactly what onSubmit sends, so validating the raw value would block
  // submit on surrounding whitespace (easy on paste) that the server would have accepted.
  const slugCheck = trimmedSlug ? validateOrgSlug(trimmedSlug) : { ok: true as const };
  const slugError = !slugCheck.ok ? orgSlugErrorMessage(slugCheck.reason) : null;

  function onName(next: string) {
    setName(next);
    // The URL follows the name until the user takes it over.
    if (!slugTouched) setSlug(slugifyOrgName(next));
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!trimmed || !trimmedSlug || slugError || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("name", trimmed);
    fd.set("orgSlug", trimmedSlug);
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
            hint={
              slugError ? undefined : `Your organization will live at webhook.co/org/${slug || "…"}`
            }
            error={slugError ?? undefined}
          />
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={pending}
              disabled={!trimmed || !trimmedSlug || !!slugError || pending}
            >
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
