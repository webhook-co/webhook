"use client";

import { Banner, Button } from "@webhook-co/ui";
import type { Cursor } from "@webhook-co/shared";
import * as React from "react";

import type { EventFilterParams } from "@/lib/event-filters";
import type { MintTicketResult, WebSocketCtor } from "@/lib/live-events";
import { useEventPaging } from "@/lib/use-event-paging";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

import { EventsTable } from "./events-table";
import { LiveTailBar } from "./live-tail-bar";

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
  /** Mint a short-lived listen ticket (the session-authed server action), pre-bound with slug + endpointId
   *  by the page (scope-agnostic — see LiveEventsSessionOptions.mintTicket). */
  mintTicket?: () => Promise<MintTicketResult>;
  /** Whether an active filter BLOCKS live (a live-specific subset of the applied filters — a lower date bound
   *  is compatible; see hasLiveIncompatibleFilters). Disables the Live toggle rather than stream contradicting
   *  events. Distinct from `isFiltered` (which drives the empty-copy and DOES count the date range). */
  filtersBlockLive?: boolean;
  /** Test seam: inject a FakeWebSocket. Undefined in the app → the browser `WebSocket` is used. */
  webSocketCtor?: WebSocketCtor;
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
  filtersBlockLive,
  webSocketCtor,
}: EventsListProps) {
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

  return (
    <div className="flex flex-col gap-4">
      <LiveTailBar
        endpointId={endpointId}
        liveWsUrl={liveWsUrl}
        mintTicket={mintTicket}
        filtersBlockLive={filtersBlockLive}
        setItems={setItems}
        webSocketCtor={webSocketCtor}
      />
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
