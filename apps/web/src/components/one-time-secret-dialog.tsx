"use client";

import {
  Banner,
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@webhook-co/ui";
import type { ReactNode } from "react";

export interface OneTimeSecretDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** The signing secret, shown ONCE. null while the dialog is closed. */
  secret: string | null;
}

/**
 * The one-time signing-secret reveal — shared by destination CREATE and ROTATE so this security-sensitive
 * surface ("this is the only time you'll see this secret") can't drift between the two. hideCloseButton +
 * warn Banner + mono code + CopyButton + Done (mirrors the API-key reveal). The secret is
 * never persisted or logged — it lives only in the caller's transient state, and only renders while the
 * dialog is open AND a secret is present.
 */
export function OneTimeSecretDialog({
  open,
  onClose,
  title,
  description,
  secret,
}: OneTimeSecretDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Banner tone="warn">
          This is the only time you&apos;ll see this signing secret — copy it now.
        </Banner>
        {open && secret ? (
          <div className="flex items-center gap-2 rounded-control border border-hairline bg-surface-sunken p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{secret}</code>
            <CopyButton value={secret} size="sm" />
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
