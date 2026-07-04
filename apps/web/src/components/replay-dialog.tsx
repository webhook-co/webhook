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
  Label,
  Select,
  Spinner,
  StatusPill,
} from "@webhook-co/ui";
import Link from "next/link";
import * as React from "react";

import { deliveryCopy } from "@/lib/delivery-copy";
import type { ReplayAttemptView, ReplayResult } from "@/server/replay-actions";
import type { DestinationItem } from "@/server/replay-destinations";

export interface ReplayDialogProps {
  open: boolean;
  onClose: () => void;
  eventId: string;
  destinations: readonly DestinationItem[];
  /** True when the destinations load faulted — rendered as an error, NEVER as the "you have none" state. */
  destinationsError?: boolean;
  replay: (eventId: string, destinationId: string) => Promise<ReplayResult>;
}

// The dialog's flow state. `picking` is the destination chooser; `error` is a genuine {ok:false} fault (the
// dialog stays open so the user can retry); `result` holds an {ok:true} attempt whose status we render
// HONESTLY — a `blocked`/`failed`/`dead` attempt is still an {ok:true} result, so we never imply success.
type ReplayState =
  | { kind: "picking" }
  | { kind: "error"; message: string }
  | { kind: "result"; attempt: ReplayAttemptView };

/**
 * The "replay a captured event to a registered destination" dialog. The server-side replay routes through
 * the engine (the only guarded egress); the outcome is a real DeliveryAttempt whose status we render via
 * `deliveryCopy` — a `blocked`/`failed` result is a truthful outcome, NOT a fault, so it reads honestly with
 * its own tone rather than a blanket "success". Only a genuine {ok:false} fault (event/destination gone,
 * engine unavailable) shows the danger Banner and keeps the picker open to retry. A synchronous `pendingRef`
 * latch guards against a same-tick double-click firing the replay twice (mirrors the destinations manager).
 */
export function ReplayDialog({
  open,
  onClose,
  eventId,
  destinations,
  destinationsError,
  replay,
}: ReplayDialogProps) {
  // Only enabled destinations are sensible replay targets — an auto-disabled row shouldn't be pickable.
  const targets = React.useMemo(
    () => destinations.filter((d) => d.disabledAt === null),
    [destinations],
  );

  const [selectedId, setSelectedId] = React.useState<string>(() => targets[0]?.id ?? "");
  const [state, setState] = React.useState<ReplayState>({ kind: "picking" });

  // Keep the selection valid as the target set changes, and reset the flow each time the dialog opens.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelectedId(targets[0]?.id ?? "");
      setState({ kind: "picking" });
    }
  }

  // A synchronous in-flight latch — `pending` state re-renders a frame late, so it alone can't block a
  // same-tick double-submit (which would replay twice). `pending` mirrors it for the disabled/spinner UI.
  const pendingRef = React.useRef(false);
  const [pending, setPending] = React.useState(false);

  const selectId = React.useId();

  async function handleReplay() {
    if (pendingRef.current || selectedId === "") return;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await replay(eventId, selectedId);
      if (result.ok) {
        setState({ kind: "result", attempt: result.attempt });
      } else {
        setState({ kind: "error", message: result.error });
      }
    } catch {
      setState({ kind: "error", message: "We couldn't replay the event. Please try again." });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function replayAgain() {
    setState({ kind: "picking" });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o || pending) return;
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replay to a destination</DialogTitle>
          <DialogDescription>
            Send this captured event to one of your registered destinations. We sign the delivery so
            the destination can verify it.
          </DialogDescription>
        </DialogHeader>

        {destinationsError ? (
          // A load fault must read as an error, NEVER as "you have none" — an org that HAS destinations would
          // otherwise be wrongly told to register one and couldn't replay. No picker on an error.
          <Banner tone="danger">
            We couldn&apos;t load your destinations. Refresh and try again.
          </Banner>
        ) : targets.length === 0 ? (
          <p className="text-sm text-fg-secondary">
            Register a replay destination first.{" "}
            <Link href="/destinations" className="text-fg underline underline-offset-4">
              Manage destinations
            </Link>
            .
          </p>
        ) : state.kind === "result" ? (
          <ReplayResultBlock attempt={state.attempt} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={selectId}>Destination</Label>
              <Select
                id={selectId}
                value={selectedId}
                disabled={pending}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {targets.map((dest) => (
                  <option key={dest.id} value={dest.id}>
                    {dest.label ?? dest.url}
                  </option>
                ))}
              </Select>
            </div>
            {state.kind === "error" ? <Banner tone="danger">{state.message}</Banner> : null}
            {pending ? (
              <div className="flex items-center gap-2 text-sm text-fg-secondary">
                <Spinner size="sm" />
                Replaying…
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {destinationsError || targets.length === 0 ? (
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Close
              </Button>
            </DialogClose>
          ) : state.kind === "result" ? (
            <>
              <Button type="button" variant="secondary" onClick={replayAgain}>
                Replay again
              </Button>
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </>
          ) : (
            <>
              <DialogClose asChild>
                <Button type="button" variant="secondary" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" onClick={handleReplay} disabled={pending || selectedId === ""}>
                {pending ? "Replaying…" : "Replay"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The honest result of a completed replay. The header is deliberately NEUTRAL ("Replay recorded") — the
 * StatusPill carries the real outcome (ok/danger/neutral tone + plain-words label from `deliveryCopy`), so a
 * `blocked`/`failed`/`dead` attempt never reads as a success. A retry clock isn't meaningful for a one-shot
 * replay, so `deliveryCopy` is called with no options.
 */
function ReplayResultBlock({ attempt }: { attempt: ReplayAttemptView }) {
  const copy = deliveryCopy(attempt.status);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-secondary">Replay recorded.</p>
      <div className="flex items-center gap-2">
        <StatusPill tone={copy.tone} title={copy.hint}>
          {copy.label}
        </StatusPill>
        {attempt.statusCode !== null ? (
          <span className="text-sm text-fg-secondary">· {attempt.statusCode}</span>
        ) : null}
      </div>
      {copy.hint ? <p className="text-sm text-fg-secondary">{copy.hint}</p> : null}
      {attempt.error ? <p className="text-sm text-fg-muted">{attempt.error}</p> : null}
    </div>
  );
}
