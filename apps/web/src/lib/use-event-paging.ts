"use client";

import type { Cursor } from "@webhook-co/shared";
import * as React from "react";

import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

export interface UseEventPagingOptions {
  readonly initialItems: readonly EventSummaryItem[];
  readonly initialCursor: Cursor | null;
  /**
   * Fetch the page after `cursor`. A THUNK over the cursor, not the action itself: the endpoint-scoped browse
   * binds `{endpointId, filters}` and the org-wide one binds `{filters}`, and neither shape belongs in here.
   */
  readonly loadMore: (cursor: Cursor) => Promise<LoadMoreEventsResult>;
}

export interface EventPaging {
  readonly items: readonly EventSummaryItem[];
  /** Exposed for the live tail, which prepends arrived events into the same list. */
  readonly setItems: React.Dispatch<React.SetStateAction<readonly EventSummaryItem[]>>;
  /** null once the last page has been fetched — the caller hides the button on it. */
  readonly cursor: Cursor | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly loadMore: () => Promise<void>;
}

/**
 * The events "Load older" pager: page state, the in-flight latch, and the error copy.
 *
 * Extracted so the endpoint-scoped list and the org-wide one share ONE implementation. The reason this is a
 * hook rather than copied twice is the `pendingRef` below: it guards a real bug, and a second hand-rolled
 * copy is how that bug comes back.
 *
 * A failed page keeps the rows already on screen — losing them would punish the reader for our fault.
 */
export function useEventPaging({
  initialItems,
  initialCursor,
  loadMore,
}: UseEventPagingOptions): EventPaging {
  const [items, setItems] = React.useState<readonly EventSummaryItem[]>(initialItems);
  const [cursor, setCursor] = React.useState<Cursor | null>(initialCursor);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Synchronous in-flight latch — `pending` state re-renders a frame late, so it can't block a same-tick
  // double-click (which would skip a page by advancing the cursor twice).
  const pendingRef = React.useRef(false);

  const handleLoadMore = React.useCallback(async () => {
    if (pendingRef.current || cursor === null) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await loadMore(cursor);
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
  }, [cursor, loadMore]);

  return { items, setItems, cursor, pending, error, loadMore: handleLoadMore };
}
