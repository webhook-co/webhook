"use client";

import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

import { formatDateTime } from "@/lib/format";
import type { EndpointActionResult, RotateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem } from "@/server/endpoints";

import { OneTimeUrlDialog } from "./one-time-url-dialog";

export interface EndpointDetailProps {
  endpoint: EndpointItem;
  /** Rotate the ingest token (hard cutover) → the NEW one-time URL. Injected by the gated page. */
  rotateEndpoint: (endpointId: string) => Promise<RotateEndpointResult>;
  /** Soft-delete the endpoint. Injected by the gated page. */
  deleteEndpoint: (endpointId: string) => Promise<EndpointActionResult>;
}

export function EndpointDetail({ endpoint, rotateEndpoint, deleteEndpoint }: EndpointDetailProps) {
  const router = useRouter();

  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [rotatePending, setRotatePending] = React.useState(false);
  const [rotateError, setRotateError] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deletePending, setDeletePending] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  // Synchronous in-flight latches — `*Pending` state can't block a same-tick double-fire (it re-renders a
  // frame later); these refs reliably stop a second rotate (a 2nd token whose URL is lost) / delete.
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
      // Soft-deleted: leave the detail page — the endpoint is now hidden from the list. (The component
      // unmounts on navigation, so the in-flight latches need no reset on this path.)
      router.push("/endpoints");
      router.refresh();
    } catch {
      setDeleteError("We couldn't delete the endpoint. Please try again.");
      setDeletePending(false);
      deletePendingRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>{endpoint.name}</CardTitle>
          <Badge tone={endpoint.paused ? "neutral" : "ok"}>
            {endpoint.paused ? "Paused" : "Active"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-secondary">Endpoint ID</dt>
            <dd className="flex items-center gap-2">
              <code className="font-mono text-fg">{endpoint.id}</code>
              <CopyButton value={endpoint.id} size="sm" />
            </dd>
            <dt className="text-fg-secondary">Created</dt>
            <dd className="text-fg">{formatDateTime(endpoint.createdAt)}</dd>
          </dl>
          <p className="leading-snug text-fg-secondary">
            Your signed webhook URL is shown only once, when you create or rotate the endpoint.
            Rotate to mint a new one — the current URL stops working the moment you do.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setRotateOpen(true)}>
          Rotate URL
        </Button>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete endpoint
        </Button>
      </div>

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
              The current webhook URL stops working the moment you rotate — there&apos;s no grace
              window. Update it everywhere it&apos;s configured first. You&apos;ll see the new URL
              once.
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
    </div>
  );
}
