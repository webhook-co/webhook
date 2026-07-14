"use client";

import { Banner, Button, Card, CardContent, Field } from "@webhook-co/ui";
import { slugifyOrgName } from "@webhook-co/shared";
import { useState, useTransition } from "react";

import type { CreateTeamResult } from "@/server/org-create-actions";

export interface CreateTeamFormProps {
  readonly create: (formData: FormData) => Promise<CreateTeamResult>;
}

/**
 * Create a team from a display name.
 *
 * We ask only for a name and derive the URL from it — most people don't want to pick a slug, and the one they
 * get is renameable in settings. A live preview shows the BASE of the URL they'll get; the server appends a
 * short random suffix (so URLs stay unique), so the preview shows the stem, not a promise of the exact slug —
 * anything else would be a lie the moment two teams share a name.
 *
 * On success the action redirects to the new org, so control never returns; a returned result is an error to
 * render inline.
 */
export function CreateTeamForm({ create }: CreateTeamFormProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = name.trim();
  const previewBase = trimmed ? slugifyOrgName(trimmed) || "org" : "";

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!trimmed || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("name", trimmed);
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
            label="Team name"
            placeholder="e.g. Acme Engineering"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            maxLength={100}
            autoFocus
            hint={
              previewBase
                ? // The stem only — the server appends a short unique suffix, and it's all renameable later.
                  `Your team's URL will be webhook.co/org/${previewBase}-… — you can change it later.`
                : "You can change the name and the URL later."
            }
          />
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={pending} disabled={!trimmed || pending}>
              {pending ? "Creating…" : "Create team"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
