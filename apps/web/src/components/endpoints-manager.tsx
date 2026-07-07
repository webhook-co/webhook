"use client";

import {
  Badge,
  Banner,
  Button,
  Combobox,
  type ComboboxOption,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Label,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import {
  clampDedupWindow,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  isDedupWindowInRange,
  MAX_DEDUP_WINDOW_SECONDS,
  MIN_DEDUP_WINDOW_SECONDS,
  type DedupConfig,
} from "@webhook-co/shared";
import Link from "next/link";
import * as React from "react";

import { formatDate } from "@/lib/format";
import type {
  CreateEndpointResult,
  EndpointActionResult,
  RotateEndpointResult,
} from "@/server/endpoint-actions";
import type { EndpointItem, EndpointsResult } from "@/server/endpoints";

import { EndpointControls } from "./endpoint-controls";
import { IngestUrlDialog } from "./ingest-url-dialog";

// The create dialog offers the three modes that need no extra input — the `fields` editor lives on the
// endpoint's detail page (a fresh endpoint has no payloads to pick fields against yet). Labels are the plain,
// user-facing wording, never the raw enum. The DEFAULT is off (log every request, no auto-dedup) — dedup is
// opt-in; off is listed first so it reads as the default.
type CreateDedupMode = "off" | "identifier" | "content";
const CREATE_DEDUP_OPTIONS: ComboboxOption[] = [
  { value: "off", label: "Log every request (default)" },
  { value: "identifier", label: "Collapse retries automatically" },
  { value: "content", label: "Collapse identical payloads" },
];

export interface EndpointsManagerProps {
  initialResult: EndpointsResult;
  /** The active name-search term (the server already filtered `initialResult` by it). Drives the
   *  empty-state copy AND gates optimistic create so a non-matching new endpoint isn't shown filtered. */
  nameFilter?: string;
  /** The create-endpoint server action, injected by the gated page. */
  createEndpoint: (input: {
    name: string;
    dedupConfig?: DedupConfig | null;
  }) => Promise<CreateEndpointResult>;
  /** Rotate an endpoint's ingest token (hard cutover) → its NEW ingest URL. Injected by the page. */
  rotateEndpoint: (endpointId: string) => Promise<RotateEndpointResult>;
  /** Soft-delete an endpoint. Injected by the page. */
  deleteEndpoint: (endpointId: string) => Promise<EndpointActionResult>;
}

export function EndpointsManager({
  initialResult,
  nameFilter,
  createEndpoint,
  rotateEndpoint,
  deleteEndpoint,
}: EndpointsManagerProps) {
  const liveEndpoints = initialResult.status === "ok" ? initialResult.endpoints : [];
  const [endpoints, setEndpoints] = React.useState<readonly EndpointItem[]>(liveEndpoints);
  // Re-sync the list to a freshly server-filtered `initialResult` WITHOUT remounting — the manager
  // stays mounted so the just-revealed ingest URL (the transient `revealed` below) survives a
  // search-debounce navigation that would otherwise discard it. (Replaces the page-level `key` remount.)
  const [seededResult, setSeededResult] = React.useState(initialResult);
  if (seededResult !== initialResult) {
    setSeededResult(initialResult);
    setEndpoints(liveEndpoints);
  }
  const isFiltered = Boolean(nameFilter && nameFilter.trim() !== "");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  // Dedup config for the new endpoint. Defaults to OFF (log every request) — the same as an untouched (null)
  // config — so a create that doesn't touch these sends no dedupConfig at all (keeps the null = off default).
  const [dedupMode, setDedupMode] = React.useState<CreateDedupMode>("off");
  const [dedupWindow, setDedupWindow] = React.useState(String(DEFAULT_DEDUP_WINDOW_SECONDS));
  const [pending, setPending] = React.useState(false);
  // A synchronous in-flight latch: `pending` state can't block a same-tick double-submit (it re-renders a
  // frame later), so this ref reliably prevents a double-mint (two endpoints/tokens, the first URL lost).
  const pendingRef = React.useRef(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The just-minted ingest URL, held transiently for the post-create copy dialog. It's not secret — the
  // URL is viewable any time on the endpoint's page (ADR-0101) — this is just a convenience copy prompt.
  const [revealed, setRevealed] = React.useState<{ name: string; ingestUrl: string } | null>(null);

  if (initialResult.status !== "ok") {
    return (
      <Banner tone="danger">We couldn&apos;t load your endpoints. Refresh to try again.</Banner>
    );
  }

  // Gate create on a valid window (when the mode uses one) so an out-of-range entry is rejected with visible
  // feedback rather than silently clamped to a bound the user never chose.
  const windowInRange = dedupMode === "off" || isDedupWindowInRange(dedupWindow);
  const dedupWindowError =
    dedupMode !== "off" && dedupWindow.trim() !== "" && !isDedupWindowInRange(dedupWindow)
      ? "Enter a whole number of seconds between 60 and 604800 (7 days)."
      : undefined;
  const canCreate = name.trim() !== "" && windowInRange && !pending;

  function resetForm() {
    setName("");
    setDedupMode("off");
    setDedupWindow(String(DEFAULT_DEDUP_WINDOW_SECONDS));
    setFormError(null);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return; // synchronous double-submit guard (see pendingRef)
    pendingRef.current = true;
    setFormError(null);
    setPending(true);
    try {
      // Assemble the dedup config. The Create button is gated on an in-range window (windowInRange), so the
      // shared clamp only ever rounds an already-valid entry — the server is still authoritative. The DEFAULT
      // is off, and a null config already means off, so an off create sends NO dedupConfig (keeps the null
      // default rather than persisting an explicit equivalent). Opt-in modes send their explicit config.
      const windowSeconds = clampDedupWindow(dedupWindow);
      const dedupConfig: DedupConfig | undefined =
        dedupMode === "off" ? undefined : { mode: dedupMode, windowSeconds };
      const result = await createEndpoint({
        name: name.trim(),
        ...(dedupConfig ? { dedupConfig } : {}),
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      // Only show the new endpoint in the list if it matches the active name filter — otherwise it
      // would appear in a filtered view it doesn't belong to (it's server-persisted and surfaces once
      // the filter is cleared). The reveal dialog still confirms creation + shows the ingest URL.
      const matchesFilter =
        !isFiltered ||
        result.endpoint.name.toLowerCase().includes(nameFilter!.trim().toLowerCase());
      if (matchesFilter) setEndpoints((prev) => [result.endpoint, ...prev]);
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
                  You&apos;ll get a signed webhook URL, viewable any time on the endpoint&apos;s
                  page.
                </DialogDescription>
              </DialogHeader>

              <Field
                label="Endpoint name"
                placeholder="e.g. Stripe production"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-dedup-mode">Deduplication</Label>
                <Combobox
                  id="create-dedup-mode"
                  label="Deduplication"
                  options={CREATE_DEDUP_OPTIONS}
                  value={dedupMode}
                  disabled={pending}
                  onChange={(v) => setDedupMode(v as CreateDedupMode)}
                  className="w-full"
                />
                <p className="text-sm text-fg-secondary">
                  By default we log every request. Optionally collapse repeat deliveries into one
                  event — you can tune this, including matching on specific fields, any time on the
                  endpoint&apos;s page.
                </p>
              </div>

              {dedupMode !== "off" ? (
                <Field
                  label="Deduplication window (seconds)"
                  type="number"
                  inputMode="numeric"
                  min={MIN_DEDUP_WINDOW_SECONDS}
                  max={MAX_DEDUP_WINDOW_SECONDS}
                  hint="Between 60 seconds and 7 days."
                  error={dedupWindowError}
                  value={dedupWindow}
                  onChange={(e) => setDedupWindow(e.target.value)}
                  disabled={pending}
                />
              ) : null}

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
            <TableHead className="w-0 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.length === 0 ? (
            <TableEmpty colSpan={4}>
              {isFiltered
                ? "No endpoints match your search."
                : "No endpoints yet. Create one to get a signed webhook URL."}
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
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <EndpointControls
                      endpoint={endpoint}
                      variant="menu"
                      rotateEndpoint={rotateEndpoint}
                      deleteEndpoint={deleteEndpoint}
                      onDeleted={() =>
                        setEndpoints((prev) => prev.filter((e) => e.id !== endpoint.id))
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <IngestUrlDialog
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Copy your webhook URL"
        description={revealed ? `The signed ingest URL for "${revealed.name}".` : null}
        url={revealed?.ingestUrl ?? null}
      />
    </div>
  );
}
