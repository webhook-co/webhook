"use client";

import {
  Banner,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import * as React from "react";
import { flushSync } from "react-dom";

import { destinationCopy, destinationDisplayStatus } from "@/lib/destination-copy";
import { formatDate } from "@/lib/format";
import {
  createDestinationAction,
  deleteDestinationAction,
  enableDestinationAction,
  rotateDestinationSecretAction,
  setDestinationOrderedAction,
} from "@/server/replay-destination-actions";
import type { DestinationItem } from "@/server/replay-destinations";

import { DestinationKeysDialog } from "./destination-keys-dialog";
import { OneTimeSecretDialog } from "./one-time-secret-dialog";

// The reveal dialog's transient content — a freshly-minted signing secret plus the copy that frames it.
// Held only for the life of the dialog; the secret never lands in a destination row or any other state.
interface Reveal {
  secret: string;
  title: string;
  description: React.ReactNode;
}

/** All mutating ops on a row share ONE guard key so only one is ever in flight per destination — a rotate,
 *  enable, ordered-toggle, remove (and the keys read) can never race each other on the same row. */
function rowKey(id: string): string {
  return `row:${id}`;
}

export interface ReplayDestinationsManagerProps {
  initial: readonly DestinationItem[];
}

/**
 * The replay-destinations management surface: a create form + a list with per-row rotate/enable/keys/remove
 * and a strict-FIFO toggle. Mirrors endpoints-manager — optimistic row mutations, a destructive confirm,
 * inline `<Banner>` feedback (there is no Toast), and a synchronous `pendingRef` latch so a double-click
 * can't fire a mutation twice. Signing secrets are shown ONCE via OneTimeSecretDialog and are never held in
 * row state or logged.
 */
export function ReplayDestinationsManager({ initial }: ReplayDestinationsManagerProps) {
  const [destinations, setDestinations] = React.useState<readonly DestinationItem[]>(initial);
  // Reconcile the list to a fresh server-provided `initial` WITHOUT remounting (mirrors endpoints-manager):
  // out-of-band server changes — e.g. the delivery engine auto-disables a destination — must surface on the
  // next render, not only after a hard reload.
  const [seeded, setSeeded] = React.useState(initial);
  if (seeded !== initial) {
    setSeeded(initial);
    setDestinations(initial);
  }

  // Create-form state.
  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  // Row-mutation error (ordered toggle / rotate / enable), surfaced inline above the list. The REMOVE error
  // lives inside the confirm dialog instead (see removeError) — a page-level Banner would render behind it.
  const [rowError, setRowError] = React.useState<string | null>(null);

  // The transient one-time secret reveal (create or rotate). null while the dialog is closed.
  const [reveal, setReveal] = React.useState<Reveal | null>(null);

  // The destination the remove-confirm dialog is asking about (+ its in-dialog error). null while closed.
  const [removing, setRemoving] = React.useState<DestinationItem | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  // The destination whose signing-key history the Keys dialog is showing. null while closed.
  const [keysFor, setKeysFor] = React.useState<DestinationItem | null>(null);

  // A synchronous in-flight latch keyed by operation — `pending` state re-renders a frame late, so it can't
  // block a same-tick double-submit (which would mint/rotate/delete twice). `busy` mirrors it for disabling.
  const pendingRef = React.useRef<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const isBusy = (key: string) => busy.has(key);

  async function guard(key: string, run: () => Promise<void>): Promise<void> {
    if (pendingRef.current.has(key)) return; // synchronous double-fire guard
    pendingRef.current.add(key);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await run();
    } finally {
      pendingRef.current.delete(key);
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  const creating = isBusy("create");
  const canCreate = url.trim() !== "" && !creating;

  function upsert(dest: DestinationItem) {
    setDestinations((prev) =>
      prev.some((d) => d.id === dest.id)
        ? prev.map((d) => (d.id === dest.id ? dest : d))
        : [dest, ...prev],
    );
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    await guard("create", async () => {
      setFormError(null);
      setNote(null);
      try {
        const result = await createDestinationAction({
          url: url.trim(),
          label: label.trim() || undefined,
        });
        if (!result.ok) {
          setFormError(result.error);
          return;
        }
        upsert(result.destination);
        setUrl("");
        setLabel("");
        if (result.signingSecret) {
          setReveal({
            secret: result.signingSecret,
            title: "Copy your signing secret",
            description: "Sign deliveries to this destination with this secret.",
          });
        } else {
          // Idempotent re-add of a URL that's already registered — no fresh secret is minted.
          setNote("That destination is already registered.");
        }
      } catch {
        setFormError("We couldn't register the destination. Please try again.");
      }
    });
  }

  async function handleRotate(dest: DestinationItem) {
    await guard(rowKey(dest.id), async () => {
      setRowError(null);
      setNote(null);
      try {
        const result = await rotateDestinationSecretAction(dest.id);
        if (!result.ok) {
          setRowError(result.error);
          return;
        }
        setReveal({
          secret: result.signingSecret,
          title: "Copy your new signing secret",
          description: "The previous secret is retired. Update your verifier with this one.",
        });
      } catch {
        setRowError("We couldn't rotate the signing secret. Please try again.");
      }
    });
  }

  async function handleEnable(dest: DestinationItem) {
    await guard(rowKey(dest.id), async () => {
      setRowError(null);
      setNote(null);
      try {
        const result = await enableDestinationAction(dest.id);
        if (!result.ok) {
          setRowError(result.error);
          return;
        }
        upsert(result.destination);
      } catch {
        setRowError("We couldn't enable the destination. Please try again.");
      }
    });
  }

  async function handleOrdered(dest: DestinationItem, next: boolean) {
    await guard(rowKey(dest.id), async () => {
      setRowError(null);
      setNote(null);
      // Optimistically flip so the toggle feels instant; the server row is authoritative on success.
      upsert({ ...dest, ordered: next });
      try {
        const result = await setDestinationOrderedAction(dest.id, next);
        if (!result.ok) {
          upsert({ ...dest, ordered: !next }); // revert
          setRowError(result.error);
          return;
        }
        upsert(result.destination);
      } catch {
        upsert({ ...dest, ordered: !next }); // revert
        setRowError("We couldn't update the destination. Please try again.");
      }
    });
  }

  function requestRemove(dest: DestinationItem) {
    setRemoveError(null);
    setRemoving(dest);
  }

  function closeRemove() {
    setRemoving(null);
    setRemoveError(null);
  }

  async function confirmRemove() {
    const dest = removing;
    if (!dest) return;
    await guard(rowKey(dest.id), async () => {
      setRemoveError(null);
      setNote(null);
      try {
        const result = await deleteDestinationAction(dest.id);
        if (!result.ok) {
          // Keep the modal open and show the failure INSIDE it — a page-level Banner renders behind it.
          setRemoveError(result.error);
          return;
        }
        // Close the confirm dialog synchronously BEFORE the row is dropped, so Radix runs its scroll-lock
        // cleanup on the still-present modal (mirrors endpoint-controls) — otherwise the batched unmount can
        // strand <body> styles and leave the page unclickable.
        flushSync(() => closeRemove());
        setDestinations((prev) => prev.filter((d) => d.id !== dest.id));
      } catch {
        setRemoveError("We couldn't remove the destination. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleCreate}
        className="flex flex-col gap-4 rounded-card border border-hairline bg-surface-sunken p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <Field
            label="Destination URL"
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={creating}
            fieldClassName="flex-1"
            error={formError ?? undefined}
          />
          <Field
            label="Label (optional)"
            placeholder="e.g. Orders service"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={creating}
            fieldClassName="flex-1"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canCreate}>
            Add destination
          </Button>
          {note ? <span className="text-sm text-fg-secondary">{note}</span> : null}
        </div>
      </form>

      {rowError ? <Banner tone="danger">{rowError}</Banner> : null}

      {destinations.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No destinations yet</CardTitle>
            <CardDescription>
              Register a public https URL you can replay captured events to. We sign every delivery
              so the destination can verify it.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ordered</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {destinations.map((dest) => {
              // The loader yields LIVE rows only (deleted_at IS NULL), so display is "active" or "disabled"
              // here — never "revoked". Removed rows are dropped from client state in confirmRemove.
              const display = destinationDisplayStatus(dest);
              const copy = destinationCopy(display);
              const rowBusy = isBusy(rowKey(dest.id));
              return (
                <TableRow key={dest.id}>
                  <TableCell>
                    <code className="block max-w-[280px] truncate font-mono text-xs text-fg">
                      {dest.url}
                    </code>
                  </TableCell>
                  <TableCell className="text-fg-secondary">
                    {dest.label ?? <span className="text-fg-muted">—</span>}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={copy.tone} title={copy.hint}>
                      {copy.label}
                    </StatusPill>
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`Strict ordering for ${dest.label ?? dest.url}`}
                      checked={dest.ordered}
                      disabled={rowBusy}
                      onCheckedChange={(checked) => handleOrdered(dest, checked === true)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {display === "disabled" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleEnable(dest)}
                          disabled={rowBusy}
                        >
                          Enable
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setKeysFor(dest)}
                        disabled={rowBusy}
                      >
                        Keys
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRotate(dest)}
                        disabled={rowBusy}
                      >
                        Rotate secret
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => requestRemove(dest)}
                        disabled={rowBusy}
                      >
                        Remove
                      </Button>
                    </div>
                    <div className="mt-1 text-right text-xs text-fg-muted">
                      {formatDate(dest.createdAt)}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <RemoveDestinationDialog
        destination={removing}
        pending={removing ? isBusy(rowKey(removing.id)) : false}
        error={removeError}
        onCancel={closeRemove}
        onConfirm={confirmRemove}
      />

      <DestinationKeysDialog
        open={keysFor !== null}
        destinationId={keysFor?.id ?? null}
        onClose={() => setKeysFor(null)}
      />

      <OneTimeSecretDialog
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={reveal?.title ?? ""}
        description={reveal?.description}
        secret={reveal?.secret ?? null}
      />
    </div>
  );
}

// The destructive remove confirm, split out so the dialog + copy live in one place (mirrors the endpoint
// delete confirm). Escape / outside-click can't dismiss mid-flight, and a delete failure renders INSIDE the
// dialog (a page-level Banner would sit behind the modal, invisible).
function RemoveDestinationDialog({
  destination,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  destination: DestinationItem | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={destination !== null}
      onOpenChange={(open) => {
        if (open || pending) return;
        onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove destination?</DialogTitle>
          <DialogDescription>
            Remove this destination? Replays and deliveries can no longer target it.
          </DialogDescription>
        </DialogHeader>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            Remove destination
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
