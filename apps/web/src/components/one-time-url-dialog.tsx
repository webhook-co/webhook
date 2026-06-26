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

export interface OneTimeUrlDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  /** The secret URL, shown ONCE. null while the dialog is closed. */
  url: string | null;
}

/**
 * The one-time ingest-URL reveal — shared by endpoint CREATE and ROTATE so this security-sensitive surface
 * ("this is the only time you'll see this URL") can't drift between the two. hideCloseButton + warn Banner +
 * mono code + CopyButton + Done (mirrors the API-key reveal in credentials-manager). The URL is never
 * persisted or logged — it lives only in the caller's transient state for this dialog.
 */
export function OneTimeUrlDialog({
  open,
  onClose,
  title,
  description,
  url,
}: OneTimeUrlDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Banner tone="warn">This is the only time you&apos;ll see this URL — copy it now.</Banner>
        {url ? (
          <div className="flex items-center gap-2 rounded-control border border-hairline bg-surface-sunken p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{url}</code>
            <CopyButton value={url} size="sm" />
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
