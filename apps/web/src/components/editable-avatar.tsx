"use client";

import { Camera } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { bumpAvatarVersion } from "@/lib/avatar-version";

import { AvatarCropperDialog } from "./avatar-cropper";
import { UserAvatar } from "./user-avatar";

export interface EditableAvatarProps {
  readonly name: string;
  readonly email: string;
  readonly size?: number;
}

/**
 * The avatar as an editable control: the face with a small camera badge, which opens the crop dialog. After a
 * new photo is stored, `bumpAvatarVersion()` re-renders EVERY avatar on the page (nav, greeting, this card)
 * with a fresh `?v=` so they all refetch the new image immediately, and `router.refresh()` re-renders the
 * server components so the name/greeting text (re-minted into the session cookie) also catch up.
 */
export function EditableAvatar({ name, email, size = 48 }: EditableAvatarProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <UserAvatar name={name} email={email} size={size} />
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Change photo"
        className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full border border-hairline bg-surface text-fg-secondary shadow-sm transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)] focus-visible:outline-none"
      >
        <Camera className="size-3.5" aria-hidden="true" />
      </button>
      <AvatarCropperDialog
        open={open}
        onOpenChange={setOpen}
        onUploaded={() => {
          setOpen(false);
          bumpAvatarVersion();
          router.refresh();
        }}
      />
    </div>
  );
}
