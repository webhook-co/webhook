"use client";

import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import Link from "next/link";
import * as React from "react";

import { formatDate } from "@/lib/format";
import type { CreateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem, EndpointsResult } from "@/server/endpoints";

import { OneTimeUrlDialog } from "./one-time-url-dialog";

export interface EndpointsManagerProps {
  initialResult: EndpointsResult;
  /** The create-endpoint server action, injected by the gated page. */
  createEndpoint: (input: { name: string }) => Promise<CreateEndpointResult>;
}

export function EndpointsManager({ initialResult, createEndpoint }: EndpointsManagerProps) {
  const [endpoints, setEndpoints] = React.useState<readonly EndpointItem[]>(
    initialResult.status === "ok" ? initialResult.endpoints : [],
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);
  // A synchronous in-flight latch: `pending` state can't block a same-tick double-submit (it re-renders a
  // frame later), so this ref reliably prevents a double-mint (two endpoints/tokens, the first URL lost).
  const pendingRef = React.useRef(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The just-minted ingest URL, held transiently for the one-time reveal — never re-displayed after.
  const [revealed, setRevealed] = React.useState<{ name: string; ingestUrl: string } | null>(null);

  if (initialResult.status !== "ok") {
    return (
      <Banner tone="danger">We couldn&apos;t load your endpoints. Refresh to try again.</Banner>
    );
  }

  const canCreate = name.trim() !== "" && !pending;

  function resetForm() {
    setName("");
    setFormError(null);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return; // synchronous double-submit guard (see pendingRef)
    pendingRef.current = true;
    setFormError(null);
    setPending(true);
    try {
      const result = await createEndpoint({ name: name.trim() });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setEndpoints((prev) => [result.endpoint, ...prev]);
      setCreateOpen(false);
      resetForm();
      setRevealed({ name: result.endpoint.name, ingestUrl: result.ingestUrl });
    } catch {
      setFormError("We couldn't create the endpoint. Please try again.");
    } finally {
      setPending(false);
      pendingRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button>Create endpoint</Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-5">
              <DialogHeader>
                <DialogTitle>Create endpoint</DialogTitle>
                <DialogDescription>
                  You&apos;ll get a signed webhook URL — shown once, right after it&apos;s created.
                </DialogDescription>
              </DialogHeader>

              <Field
                label="Endpoint name"
                placeholder="e.g. Stripe production"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />

              {formError ? <Banner tone="danger">{formError}</Banner> : null}

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={!canCreate}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.length === 0 ? (
            <TableEmpty colSpan={3}>
              No endpoints yet. Create one to get a signed webhook URL.
            </TableEmpty>
          ) : (
            endpoints.map((endpoint) => (
              <TableRow key={endpoint.id}>
                <TableCell>
                  <Link
                    href={`/endpoints/${endpoint.id}`}
                    className="font-medium text-fg underline-offset-4 hover:underline"
                  >
                    {endpoint.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge tone={endpoint.paused ? "neutral" : "ok"}>
                    {endpoint.paused ? "Paused" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell className="text-fg-secondary">
                  {formatDate(endpoint.createdAt)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <OneTimeUrlDialog
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Copy your webhook URL"
        description={revealed ? `The signed ingest URL for "${revealed.name}".` : null}
        url={revealed?.ingestUrl ?? null}
      />
    </div>
  );
}
