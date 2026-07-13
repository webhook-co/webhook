"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  StatusPill,
  type StatusTone,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import * as React from "react";

import { formatDate } from "@/lib/format";
import { listDestinationSecretsAction } from "@/server/replay-destination-actions";

interface KeyItem {
  id: string;
  status: string;
  createdAt: Date;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: readonly KeyItem[] };

/** Map a signing-key lifecycle status to its functional tone (active live / retiring overlap / else neutral). */
function keyTone(status: string): StatusTone {
  if (status === "active") return "ok";
  if (status === "retiring") return "warn";
  return "neutral";
}

export interface DestinationKeysDialogProps {
  /** The CANONICAL org slug — the org the action acts in (the org comes from the URL, not the cookie). */
  slug: string;
  open: boolean;
  destinationId: string | null;
  onClose: () => void;
}

/**
 * A read-only view of a destination's signing-key history — parity with the api/cli `listSigningSecrets`
 * surface. Loads on open via `listDestinationSecretsAction` and renders METADATA ONLY (status + age); the
 * secret plaintext is never fetched or shown here (that's the one-time reveal's job). Plain `Dialog`
 * composition — deliberately NOT the one-time-secret dialog.
 */
export function DestinationKeysDialog({
  slug,
  open,
  destinationId,
  onClose,
}: DestinationKeysDialogProps) {
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });

  React.useEffect(() => {
    if (!open || !destinationId) return;
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const res = await listDestinationSecretsAction(slug, destinationId);
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "error", message: res.error });
          return;
        }
        setState({ kind: "ready", items: res.items });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "We couldn't load the signing keys." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, destinationId, slug]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Signing keys</DialogTitle>
          <DialogDescription>
            The signing keys for this destination — status and age only, never the secret itself.
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : state.kind === "error" ? (
          <Banner tone="danger">{state.message}</Banner>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.items.length === 0 ? (
                <TableEmpty colSpan={2}>No signing keys yet.</TableEmpty>
              ) : (
                state.items.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <StatusPill tone={keyTone(key.status)}>{key.status}</StatusPill>
                    </TableCell>
                    <TableCell className="text-fg-secondary">{formatDate(key.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
