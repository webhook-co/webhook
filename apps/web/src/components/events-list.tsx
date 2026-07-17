"use client";

import { Banner, Button, cn } from "@webhook-co/ui";
import type { Cursor } from "@webhook-co/shared";
import { LISTEN_LAG_CAP } from "@webhook-co/shared";
import * as React from "react";

import type { EventFilterParams } from "@/lib/event-filters";
import type { MintTicketResult, WebSocketCtor } from "@/lib/live-events";
import { useEventPaging } from "@/lib/use-event-paging";
import { useLiveEvents } from "@/lib/use-live-events";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

import { EventsTable } from "./events-table";

export interface EventsListProps {
  endpointId: string;
  initialItems: readonly EventSummaryItem[];
  initialCursor: Cursor | null;
  /** The active filters (raw), threaded into "Load older" so paging stays within the filtered set. */
  filterParams: EventFilterParams;
  /** Whether a filter is actually APPLIED (computed from the PARSED filters by the page) — drives the
   *  empty-state copy honestly (a dropped/invalid param doesn't claim "no events match"). */
  isFiltered: boolean;
  /** Fetch the next page (server action), injected by the gated page. */
  loadMore: (input: {
    endpointId: string;
    cursor: Cursor;
    filters: EventFilterParams;
  }) => Promise<LoadMoreEventsResult>;
  /** The `wss://…/listen` URL for the live tail, derived server-side (never hardcoded here). Paired with
   *  `mintTicket`; when either is absent the Live toggle isn't rendered. */
  liveWsUrl?: string;
  /** Mint a short-lived listen ticket (the session-authed server action), passed by the page. */
  mintTicket?: (endpointId: string) => Promise<MintTicketResult>;
  /** Test seam: inject a FakeWebSocket. Undefined in the app → the browser `WebSocket` is used. */
  webSocketCtor?: WebSocketCtor;
}

/** A stable, always-failing mint used only when the live wiring is absent (the hook stays disabled). */
const UNAVAILABLE_MINT = async (): Promise<MintTicketResult> => ({
  ok: false,
  error: "Live isn't available here.",
});

/** Render the capped backlog count: over the server cap shows `<cap>+` (matches the tail's over-cap sentinel). */
function formatBacklog(lag: { backlogCount: number } | undefined): string | null {
  if (!lag) return null;
  return lag.backlogCount > LISTEN_LAG_CAP ? `${LISTEN_LAG_CAP}+` : String(lag.backlogCount);
}

export function EventsList({
  endpointId,
  initialItems,
  initialCursor,
  filterParams,
  isFiltered,
  loadMore,
  liveWsUrl,
  mintTicket,
  webSocketCtor,
}: EventsListProps) {
  const [live, setLive] = React.useState(false);
  const liveAvailable = liveWsUrl !== undefined && mintTicket !== undefined;

  // Bind this browse's shape onto the shared pager: endpoint + the raw filters, so paging stays inside the
  // filtered set. Memoised so the hook's callback identity is stable across renders.
  const fetchPage = React.useCallback(
    (cursor: Cursor) => loadMore({ endpointId, cursor, filters: filterParams }),
    [endpointId, filterParams, loadMore],
  );
  const {
    items,
    setItems,
    cursor,
    pending,
    error,
    loadMore: handleLoadMore,
  } = useEventPaging({
    initialItems,
    initialCursor,
    loadMore: fetchPage,
  });

  // The live tail. `enabled` gates on the toggle AND the wiring being present; the hook auto-pauses on a
  // hidden tab / unmount and prepends+dedups arrived events into `items`. A safe no-op mint stands in when
  // the wiring is absent (the hook stays disabled, so it never runs).
  const {
    connection,
    caughtUp,
    lag,
    error: liveError,
  } = useLiveEvents({
    enabled: live && liveAvailable,
    wsUrl: liveWsUrl ?? "",
    endpointId,
    mintTicket: mintTicket ?? UNAVAILABLE_MINT,
    setItems,
    WebSocketCtor: webSocketCtor,
  });

  // Honest live indicator — a colored, pulsing dot + terse status. Green = caught up, amber = behind by a
  // (capped) count. We never claim "instant": new events surface within a few seconds.
  let dotTone = "bg-fg-faint";
  let pulse = false;
  let statusText = "connecting…";
  if (connection === "connected") {
    if (caughtUp) {
      dotTone = "bg-ok";
      pulse = true;
      statusText = "live · caught up";
    } else {
      const behind = formatBacklog(lag);
      dotTone = "bg-warn";
      pulse = true;
      statusText = behind ? `live · ${behind} behind` : "live · catching up";
    }
  } else if (connection === "disconnected") {
    statusText = "reconnecting…";
  }

  return (
    <div className="flex flex-col gap-4">
      {liveAvailable ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-h-5 items-center gap-2 text-sm" aria-live="polite">
            {live ? (
              <>
                <span
                  aria-hidden="true"
                  className={cn("size-2 rounded-full", dotTone, pulse && "animate-pulse")}
                />
                <span className="text-fg-secondary">{statusText}</span>
                {liveError ? <span className="text-warn">· {liveError}</span> : null}
              </>
            ) : (
              <span className="text-fg-muted">
                new events appear within a few seconds when live is on.
              </span>
            )}
          </div>
          <Button
            variant={live ? "secondary" : "primary"}
            size="sm"
            aria-pressed={live}
            onClick={() => setLive((v) => !v)}
          >
            {live ? "Stop live" : "Go live"}
          </Button>
        </div>
      ) : null}
      <EventsTable
        items={items}
        isFiltered={isFiltered}
        emptyMessage="No events yet. Point a provider at this endpoint's webhook URL to start receiving events."
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {cursor !== null ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={handleLoadMore} disabled={pending}>
            {pending ? "Loading…" : "Load older events"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
