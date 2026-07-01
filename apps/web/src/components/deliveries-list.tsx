"use client";

import {
  Button,
  MultiSelect,
  type MultiSelectOption,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  Banner,
} from "@webhook-co/ui";
import { DELIVERY_STATUSES, type Cursor } from "@webhook-co/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import * as React from "react";

import { deliveryCopy } from "@/lib/delivery-copy";
import type { DeliveryFilterParams } from "@/lib/delivery-filters";
import { formatDate } from "@/lib/format";
import type { LoadMoreDeliveriesResult } from "@/server/delivery-actions";
import type { DeliveryItem } from "@/server/deliveries";

/** A long uuid, trimmed to its leading segment for a scannable table cell. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

// ── Filter bar ──────────────────────────────────────────────────────────────────────────────────────

// The deliveries-list filter bar, driven entirely by the URL query so the filtered view is shareable,
// bookmarkable, and refresh-safe: a single status MULTI-select (`?status=a&status=b`). The select pushes
// on change; the server page re-reads the query, re-runs the filtered load, and re-keys the list. No
// client-side filtering — the DB does it. This mirrors the events filter bar's optimistic-selection
// pattern so rapid multi-toggling (faster than the RSC round-trip) computes each toggle against the live
// selection instead of a stale committed URL (which would drop earlier picks).
export function DeliveriesFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committedQuery = searchParams.toString();

  const [pendingStatus, setPendingStatus] = React.useState<string[] | null>(null);
  const statusSel = (pendingStatus ?? searchParams.getAll("status")).filter((s) =>
    (DELIVERY_STATUSES as readonly string[]).includes(s),
  );
  const active = statusSel.length > 0;

  const statusOptions = React.useMemo<MultiSelectOption[]>(
    () => DELIVERY_STATUSES.map((s) => ({ value: s, label: deliveryCopy(s).label })),
    [],
  );

  // The query string WE last pushed — merging against it keeps a change made within the RSC-navigation
  // commit window from starting from the stale `searchParams` snapshot. Reset once the URL commits.
  const lastPushedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    lastPushedRef.current = null;
    setPendingStatus(null);
  }, [committedQuery]);

  function apply(next: URLSearchParams) {
    const qs = next.toString();
    lastPushedRef.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function setStatus(values: readonly string[]) {
    setPendingStatus([...values]);
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    next.delete("status");
    for (const value of values) next.append("status", value);
    apply(next);
  }

  function clear() {
    setPendingStatus([]);
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    next.delete("status");
    apply(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-hairline bg-surface-sunken p-4">
      <MultiSelect
        label="Filter by status"
        placeholder="All statuses"
        options={statusOptions}
        selected={statusSel}
        onChange={setStatus}
        className="w-48"
      />
      <Button variant="secondary" onClick={clear} disabled={!active} className="ml-auto">
        Clear filters
      </Button>
    </div>
  );
}

// ── List ────────────────────────────────────────────────────────────────────────────────────────────

export interface DeliveriesListProps {
  initialItems: readonly DeliveryItem[];
  initialCursor: Cursor | null;
  /** The active filters (raw), threaded into "Load older" so paging stays within the filtered set. */
  filterParams: DeliveryFilterParams;
  /** Whether a filter is actually APPLIED (computed from the PARSED filters by the page) — drives the
   *  empty-state copy honestly (a dropped/invalid param doesn't claim "no deliveries match"). */
  isFiltered: boolean;
  /** Fetch the next page (server action), injected by the gated page. */
  loadMore: (input: {
    cursor: Cursor;
    filters: DeliveryFilterParams;
  }) => Promise<LoadMoreDeliveriesResult>;
}

export function DeliveriesList({
  initialItems,
  initialCursor,
  filterParams,
  isFiltered,
  loadMore,
}: DeliveriesListProps) {
  const [items, setItems] = React.useState<readonly DeliveryItem[]>(initialItems);
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
      const result = await loadMore({ cursor, filters: filterParams });
      if (!result.ok) {
        setError("We couldn't load more deliveries. Try again.");
        return;
      }
      setItems((prev) => [...prev, ...result.items]);
      setCursor(result.nextCursor);
    } catch {
      setError("We couldn't load more deliveries. Try again.");
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
            <TableHead>Status</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead>Attempt</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableEmpty colSpan={5}>
              {isFiltered
                ? "No deliveries match this filter. Adjust or clear it to see more."
                : "No deliveries yet. Deliveries appear here once webhooks are delivered to a destination."}
            </TableEmpty>
          ) : (
            items.map((delivery) => {
              const copy = deliveryCopy(delivery.status, { nextRetryAt: delivery.nextRetryAt });
              return (
                <TableRow key={delivery.id}>
                  <TableCell>
                    <span className="flex flex-col gap-1">
                      <StatusPill tone={copy.tone}>{copy.label}</StatusPill>
                      {copy.hint ? (
                        <span className="text-xs text-fg-muted">{copy.hint}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-fg-secondary">
                      {shortId(delivery.eventId)}
                    </code>
                  </TableCell>
                  <TableCell className="text-fg-secondary">
                    {delivery.destinationId ? (
                      <code className="font-mono text-xs">{shortId(delivery.destinationId)}</code>
                    ) : delivery.status === "forwarded" ? (
                      // A null destination on a `forwarded` row is the legacy localhost-tunnel replay.
                      <span className="text-fg-muted">localhost</span>
                    ) : (
                      <span className="text-fg-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-fg-secondary">{delivery.attempt}</TableCell>
                  <TableCell>
                    <Link
                      href={`/deliveries/${delivery.id}`}
                      className="font-medium text-fg underline-offset-4 hover:underline"
                    >
                      {formatDate(delivery.createdAt)}
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {cursor !== null ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={handleLoadMore} disabled={pending}>
            {pending ? "Loading…" : "Load older deliveries"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
