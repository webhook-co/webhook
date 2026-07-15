"use client";

import { Banner, Button, Field } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState, useTransition } from "react";

import { UserAvatar } from "@/components/user-avatar";
import { MAX_DISPLAY_NAME_LEN } from "@/lib/profile-constants";
import type { UpdateNameResult } from "@/server/profile-actions";

export interface EditableDisplayNameProps {
  readonly name: string;
  readonly email: string;
  /** The server action, injected by the page. Returns ok, or an inline error message. */
  readonly onSave: (formData: FormData) => Promise<UpdateNameResult>;
  /**
   * The avatar to render beside the name. The page passes the editable one (`<EditableAvatar>`); default to
   * the plain read-only avatar so this component stays usable on its own.
   */
  readonly avatar?: ReactNode;
}

/**
 * The profile identity card: shows your avatar / name / email, with an inline "Edit" that swaps the name into
 * a text field. On save the action re-mints the session cookie, so `router.refresh()` re-renders every surface
 * (this card, the nav, the greeting) with the new name — no re-login needed.
 */
export function EditableDisplayName({ name, email, onSave, avatar }: EditableDisplayNameProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = value.trim();

  function beginEdit() {
    setValue(name); // start from the current name each time (discard any prior aborted edit)
    setError(null);
    setEditing(true);
  }

  function save() {
    if (!trimmed || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("name", trimmed);
    startTransition(async () => {
      const res = await onSave(fd);
      if (res.ok) {
        setEditing(false);
        router.refresh(); // re-render with the re-minted cookie → new name everywhere
      } else {
        setError(res.error);
      }
    });
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-4">
        {avatar ?? <UserAvatar name={name} email={email} size={48} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-fg">{name}</span>
          <span className="truncate text-sm text-fg-secondary">{email}</span>
        </div>
        <Button variant="secondary" className="ml-auto shrink-0" onClick={beginEdit}>
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Display name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={MAX_DISPLAY_NAME_LEN}
        disabled={pending}
        autoFocus
        hint="This is how you appear across every organization you belong to."
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <div className="flex gap-2">
        <Button onClick={save} loading={pending} disabled={!trimmed || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
