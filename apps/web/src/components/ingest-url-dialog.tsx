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

export interface IngestUrlDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  /** The ingest URL to copy. null while the dialog is closed. */
  url: string | null;
}

/**
 * The ingest-URL reveal shown right after endpoint CREATE and ROTATE — shared by both so this surface can't
 * drift between the two. It's no longer a one-time reveal: the URL is always viewable on the endpoint's page
 * (ADR-0101), so the dialog just offers a quick copy and reassures you can find it again later. mono code +
 * CopyButton + Done. The URL is never persisted or logged — it lives only in the caller's transient state.
 */
export function IngestUrlDialog({ open, onClose, title, description, url }: IngestUrlDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Banner tone="info">You can view this URL any time on the endpoint&apos;s page.</Banner>
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
