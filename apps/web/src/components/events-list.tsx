"use client";

import {
  Banner,
  Button,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import type { Cursor } from "@webhook-co/shared";
import Link from "next/link";
import * as React from "react";

import type { EventFilterParams } from "@/lib/event-filters";
import { formatDateTime } from "@/lib/format";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

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
}

export function EventsList({
  endpointId,
  initialItems,
  initialCursor,
  filterParams,
  isFiltered,
  loadMore,
}: EventsListProps) {
  const [items, setItems] = React.useState<readonly EventSummaryItem[]>(initialItems);
  const [cursor, setCursor] = React.useState<Cursor | null>(initialCursor);
  const [pending, setPending] = React.useState(false);
  // Synchronous in-flight latch — `pending` state re-renders a frame late, so it can't block a same-tick
  // double-click (which would skip a page by advancing the cursor twice).
  const pendingRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleLoadMore() {
    if (pendingRef.current || cursor === null) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await loadMore({ endpointId, cursor, filters: filterParams });
      if (!result.ok) {
        setError("We couldn't load more events. Try again.");
        return;
      }
      setItems((prev) => [...prev, ...result.items]);
      setCursor(result.nextCursor);
    } catch {
      setError("We couldn't load more events. Try again.");
    } finally {
      setPending(false);
      pendingRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Received</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Verified</TableHead>
            <TableHead>Event ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableEmpty colSpan={4}>
              {isFiltered
                ? "No events match these filters. Adjust or clear them to see more."
                : "No events yet. Point a provider at this endpoint's webhook URL to start receiving events."}
            </TableEmpty>
          ) : (
            items.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <Link
                    href={`/endpoints/${endpointId}/events/${event.id}`}
                    className="font-medium text-fg underline-offset-4 hover:underline"
                  >
                    {formatDateTime(event.receivedAt)}
                  </Link>
                </TableCell>
                <TableCell className="text-fg-secondary">{event.provider ?? "—"}</TableCell>
                <TableCell>
                  {/* Neutral (not red) for unsigned: the list can't tell "verification failed" from
                      "never attempted" (that's only on the detail), so an unsigned event must not alarm. */}
                  <StatusPill tone={event.verified ? "ok" : "neutral"}>
                    {event.verified ? "Verified" : "Not verified"}
                  </StatusPill>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs text-fg-secondary">{event.id}</code>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

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
