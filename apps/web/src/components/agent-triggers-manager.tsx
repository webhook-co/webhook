"use client";

import {
  Banner,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import * as React from "react";
import { flushSync } from "react-dom";

import { formatDate } from "@/lib/format";
import { createTriggerAction, revokeTriggerAction } from "@/server/agent-trigger-actions";
import type { TriggerItem } from "@/server/agent-triggers";

// The dashboard's agent-triggers management surface: a create form (endpoint picker + optional label) and a
// list with per-row revoke. Mirrors replay-destinations-manager — optimistic row mutations, a destructive
// confirm, inline `<Banner>` feedback (there is no Toast), and a synchronous `pendingRef` latch so a
// double-click can't fire a mutation twice. A trigger holds no secret, so there is no reveal dialog. The
// consumption path (triggers.wait) is not a dashboard control — the live-events view already streams events.

/** A minimal endpoint for the create-form picker (id + display name). */
export interface EndpointOption {
  readonly id: string;
  readonly name: string;
}

export interface AgentTriggersManagerProps {
  /** The CANONICAL org slug (off OrgAccess) — the org every action below acts in. The actions take it as
   *  their first argument because the org now comes from the URL, never from the session cookie. */
  readonly slug: string;
  readonly initial: readonly TriggerItem[];
  readonly endpoints: readonly EndpointOption[];
}

function rowKey(id: string): string {
  return `row:${id}`;
}

export function AgentTriggersManager({ slug, initial, endpoints }: AgentTriggersManagerProps) {
  const [triggers, setTriggers] = React.useState<readonly TriggerItem[]>(initial);
  // Reconcile to a fresh server-provided `initial` WITHOUT remounting (mirrors the other managers): an
  // out-of-band change surfaces on the next render, not only after a hard reload.
  const [seeded, setSeeded] = React.useState(initial);
  if (seeded !== initial) {
    setSeeded(initial);
    setTriggers(initial);
  }

  // Endpoint id → display name, for rendering a row's endpoint and the picker options.
  const endpointName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const e of endpoints) m.set(e.id, e.name);
    return m;
  }, [endpoints]);
  const options = React.useMemo(
    () => endpoints.map((e) => ({ value: e.id, label: e.name, keywords: [e.id] })),
    [endpoints],
  );

  // Create-form state.
  const [endpointId, setEndpointId] = React.useState("");
  const [name, setName] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);

  // The trigger the revoke-confirm dialog is asking about (+ its in-dialog error). null while closed.
  const [revoking, setRevoking] = React.useState<TriggerItem | null>(null);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);

  // A synchronous in-flight latch keyed by operation — `busy` state re-renders a frame late, so it can't
  // block a same-tick double-submit. `busy` mirrors it for disabling.
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
  const canCreate = endpointId !== "" && !creating;
  const noEndpoints = endpoints.length === 0;

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    await guard("create", async () => {
      setFormError(null);
      try {
        const result = await createTriggerAction(slug, {
          endpointId,
          name: name.trim() || undefined,
        });
        if (!result.ok) {
          setFormError(result.error);
          return;
        }
        setTriggers((prev) => [result.trigger, ...prev]);
        setEndpointId("");
        setName("");
      } catch {
        setFormError("We couldn't create the trigger. Please try again.");
      }
    });
  }

  function requestRevoke(trigger: TriggerItem) {
    setRevokeError(null);
    setRevoking(trigger);
  }

  function closeRevoke() {
    setRevoking(null);
    setRevokeError(null);
  }

  async function confirmRevoke() {
    const trigger = revoking;
    if (!trigger) return;
    await guard(rowKey(trigger.id), async () => {
      setRevokeError(null);
      try {
        const result = await revokeTriggerAction(slug, trigger.id);
        if (!result.ok) {
          // Keep the modal open and show the failure INSIDE it — a page-level Banner renders behind it.
          setRevokeError(result.error);
          return;
        }
        // Close the confirm dialog synchronously BEFORE the row is dropped, so Radix runs its scroll-lock
        // cleanup on the still-present modal — otherwise the batched unmount can strand <body> styles.
        flushSync(() => closeRevoke());
        setTriggers((prev) => prev.filter((t) => t.id !== trigger.id));
      } catch {
        setRevokeError("We couldn't revoke the trigger. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleCreate}
        className="flex flex-col gap-4 rounded-card border border-hairline bg-surface-sunken p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="trigger-endpoint" className="text-sm font-medium text-fg">
              Endpoint
            </label>
            <Combobox
              id="trigger-endpoint"
              label="Endpoint"
              options={options}
              value={endpointId}
              onChange={setEndpointId}
              placeholder={noEndpoints ? "No endpoints yet" : "Select an endpoint…"}
              disabled={creating || noEndpoints}
            />
          </div>
          <Field
            label="Label (optional)"
            placeholder="e.g. fraud-agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            fieldClassName="flex-1"
          />
        </div>
        {formError ? <Banner tone="danger">{formError}</Banner> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canCreate}>
            Create trigger
          </Button>
          {noEndpoints ? (
            <span className="text-sm text-fg-secondary">Create an endpoint first.</span>
          ) : null}
        </div>
      </form>

      {triggers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No triggers yet</CardTitle>
            <CardDescription>
              Create a trigger so an MCP agent is woken when an endpoint captures a new event. The
              agent consumes events over MCP with{" "}
              <code className="font-mono text-xs">triggers.wait</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {triggers.map((trigger) => {
              const rowBusy = isBusy(rowKey(trigger.id));
              return (
                <TableRow key={trigger.id}>
                  <TableCell className="text-fg">
                    {trigger.name ?? <span className="text-fg-muted">—</span>}
                  </TableCell>
                  <TableCell className="text-fg-secondary">
                    {endpointName.get(trigger.endpointId) ?? (
                      <code className="font-mono text-xs text-fg-muted">{trigger.endpointId}</code>
                    )}
                  </TableCell>
                  <TableCell className="text-fg-secondary">
                    {formatDate(trigger.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => requestRevoke(trigger)}
                      disabled={rowBusy}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <RevokeTriggerDialog
        trigger={revoking}
        pending={revoking ? isBusy(rowKey(revoking.id)) : false}
        error={revokeError}
        endpointName={revoking ? (endpointName.get(revoking.endpointId) ?? null) : null}
        onCancel={closeRevoke}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}

// The destructive revoke confirm, split out so the dialog + copy live in one place. Escape / outside-click
// can't dismiss mid-flight, and a revoke failure renders INSIDE the dialog (a page-level Banner would sit
// behind the modal, invisible).
function RevokeTriggerDialog({
  trigger,
  pending,
  error,
  endpointName,
  onCancel,
  onConfirm,
}: {
  trigger: TriggerItem | null;
  pending: boolean;
  error: string | null;
  endpointName: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const which = trigger?.name ?? endpointName ?? "this trigger";
  return (
    <Dialog
      open={trigger !== null}
      onOpenChange={(open) => {
        if (open || pending) return;
        onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke trigger?</DialogTitle>
          <DialogDescription>
            Revoke {which}? Its agent stops being woken for new events. This can&apos;t be undone —
            create a new trigger to resume.
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
            Revoke trigger
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
