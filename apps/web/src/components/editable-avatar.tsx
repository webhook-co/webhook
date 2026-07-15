"use client";

import { useRouter } from "next/navigation";
import { Camera } from "lucide-react";
import * as React from "react";

import { AvatarCropperDialog } from "./avatar-cropper";
import { UserAvatar } from "./user-avatar";

export interface EditableAvatarProps {
  readonly name: string;
  readonly email: string;
  readonly size?: number;
}

/**
 * The avatar as an editable control: the face with a small camera badge, which opens the crop dialog. After a
 * new photo is stored, bump a local version so THIS avatar refetches immediately (the serve route is
 * input-less and can't otherwise be cache-busted), and `router.refresh()` so the nav / greeting / other
 * surfaces catch up on the next render.
 */
export function EditableAvatar({ name, email, size = 48 }: EditableAvatarProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [version, setVersion] = React.useState(0);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <UserAvatar name={name} email={email} size={size} version={version || undefined} />
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
          setVersion((v) => v + 1);
          router.refresh();
        }}
      />
    </div>
  );
}
