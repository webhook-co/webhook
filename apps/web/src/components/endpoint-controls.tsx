"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@webhook-co/ui";
import * as React from "react";
import { flushSync } from "react-dom";

import type { EndpointActionResult, RotateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem } from "@/server/endpoints";

import { OneTimeUrlDialog } from "./one-time-url-dialog";

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export interface EndpointControlsProps {
  endpoint: EndpointItem;
  rotateEndpoint: (endpointId: string) => Promise<RotateEndpointResult>;
  deleteEndpoint: (endpointId: string) => Promise<EndpointActionResult>;
  /** Called after a successful soft-delete — the list removes the row; the detail page navigates away. */
  onDeleted: () => void;
  /** "menu" = a ⋯ dropdown (list rows); "buttons" = explicit Rotate/Delete buttons (detail page). */
  variant: "menu" | "buttons";
}

/**
 * The rotate + delete controls for a single endpoint, shared by the list (per-row ⋯ menu) and the detail
 * page (explicit buttons) so the security-sensitive confirm copy + one-time reveal live in ONE place. Rotate
 * is a hard cutover (confirm → new one-time URL); delete is soft (confirm → onDeleted). Both carry a
 * synchronous in-flight latch so a double-fire can't mint/delete twice.
 */
export function EndpointControls({
  endpoint,
  rotateEndpoint,
  deleteEndpoint,
  onDeleted,
  variant,
}: EndpointControlsProps) {
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [rotatePending, setRotatePending] = React.useState(false);
  const [rotateError, setRotateError] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deletePending, setDeletePending] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const rotatePendingRef = React.useRef(false);
  const deletePendingRef = React.useRef(false);

  async function confirmRotate() {
    if (rotatePendingRef.current) return;
    rotatePendingRef.current = true;
    setRotatePending(true);
    setRotateError(null);
    try {
      const result = await rotateEndpoint(endpoint.id);
      if (!result.ok) {
        setRotateError(result.error);
        return;
      }
      setRotateOpen(false);
      setRevealed(result.ingestUrl);
    } catch {
      setRotateError("We couldn't rotate the endpoint. Please try again.");
    } finally {
      setRotatePending(false);
      rotatePendingRef.current = false;
    }
  }

  async function confirmDelete() {
    if (deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteError(null);
    try {
      const result = await deleteEndpoint(endpoint.id);
      if (!result.ok) {
        setDeleteError(result.error);
        setDeletePending(false);
        deletePendingRef.current = false;
        return;
      }
      // Commit the dialog close BEFORE the parent removes this row. The Dialog has no exit animation, so
      // flushSync forces Radix + react-remove-scroll to run their close cleanup (restoring <body>
      // pointer-events / scroll-lock) synchronously; otherwise React could batch the close with the
      // parent's optimistic row removal into one commit that unmounts the still-open modal and strands
      // those body styles, leaving the page unclickable until a reload.
      flushSync(() => setDeleteOpen(false));
      onDeleted();
    } catch {
      setDeleteError("We couldn't delete the endpoint. Please try again.");
      setDeletePending(false);
      deletePendingRef.current = false;
    }
  }

  return (
    <>
      {variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${endpoint.name}`}
            className="grid size-8 place-items-center rounded-control text-fg-muted outline-none transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
          >
            <MoreIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRotateOpen(true)}>Rotate URL</DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setRotateOpen(true)}>
            Rotate URL
          </Button>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete endpoint
          </Button>
        </div>
      )}

      <Dialog
        open={rotateOpen}
        onOpenChange={(open) => {
          if (open || rotatePending) return;
          setRotateOpen(false);
          setRotateError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate webhook URL?</DialogTitle>
            <DialogDescription>
              The current webhook URL for &quot;{endpoint.name}&quot; stops working the moment you
              rotate — there&apos;s no grace window. Update it everywhere it&apos;s configured
              first. You&apos;ll see the new URL once.
            </DialogDescription>
          </DialogHeader>
          {rotateError ? <Banner tone="danger">{rotateError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={rotatePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={confirmRotate} disabled={rotatePending}>
              Rotate URL
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (open || deletePending) return;
          setDeleteOpen(false);
          setDeleteError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete endpoint?</DialogTitle>
            <DialogDescription>
              &quot;{endpoint.name}&quot; stops receiving webhooks immediately. Its past events stay
              inspectable. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <Banner tone="danger">{deleteError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={deletePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmDelete} disabled={deletePending}>
              Delete endpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeUrlDialog
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Copy your new webhook URL"
        description="The old URL has stopped working. Point your provider at this one."
        url={revealed}
      />
    </>
  );
}
