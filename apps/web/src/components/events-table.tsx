"use client";

import {
  ProviderLogo,
  providerDisplayName,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import Link from "next/link";

import { formatDateTime } from "@/lib/format";
import { orgHref, useOrgSlug } from "@/lib/org-path";
import { verificationStatePill } from "@/lib/verification-state";
import type { EventSummaryItem } from "@/server/events";

export interface EventsTableProps {
  readonly items: readonly EventSummaryItem[];
  /** Whether a filter is actually APPLIED (from the PARSED filters) — drives the empty copy honestly. */
  readonly isFiltered: boolean;
  /**
   * Endpoint id → display name. PRESENCE renders the Endpoint column; omit it on a page that is already
   * scoped to one endpoint, where the column would repeat the same value on every row.
   *
   * A plain Record (not a Map) because this crosses a props boundary. The org page builds it from the
   * `loadEndpoints` call it already makes for the endpoint filter, so there is no per-row cost and no N+1.
   */
  readonly endpointNames?: Readonly<Record<string, string>>;
  /** Empty-state copy when nothing is filtered. The two browses onboard differently. */
  readonly emptyMessage: string;
}

/**
 * The events table: rows only, no paging and no live tail.
 *
 * Presentational and state-free, so the endpoint-scoped list and the org-wide one render IDENTICAL rows and
 * cannot drift on the columns, the link shape, or the verification pill.
 */
export function EventsTable({ items, isFiltered, endpointNames, emptyMessage }: EventsTableProps) {
  // The org this is rendered in — read from the URL, which is the source of truth for it.
  const slug = useOrgSlug();
  const showEndpoint = endpointNames !== undefined;
  const colSpan = showEndpoint ? 5 : 4;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Received</TableHead>
          {showEndpoint ? <TableHead>Endpoint</TableHead> : null}
          <TableHead>Provider</TableHead>
          <TableHead>Verified</TableHead>
          <TableHead>Event ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableEmpty colSpan={colSpan}>
            {isFiltered
              ? "No events match these filters. Adjust or clear them to see more."
              : emptyMessage}
          </TableEmpty>
        ) : (
          items.map((event) => (
            <TableRow key={event.id}>
              <TableCell>
                {/* The ROW's own endpoint, never a list-level prop: a list can carry events from many
                    endpoints, and `loadEvent` asserts `event.endpointId !== endpointId → not_found`, so a
                    prop-built href would 404 every row that came from a different endpoint. */}
                <Link
                  href={orgHref(slug, `/endpoints/${event.endpointId}/events/${event.id}`)}
                  className="font-medium text-fg underline-offset-4 hover:underline"
                >
                  {formatDateTime(event.receivedAt)}
                </Link>
              </TableCell>
              {showEndpoint ? (
                <TableCell className="text-fg-secondary">
                  {/* An endpoint absent from the map is a SOFT-DELETED one (ADR-0076 keeps its events
                      listable). Fall back to neutral prose, never the raw uuid — the house rule is that a
                      raw id is never the visible label. */}
                  {endpointNames[event.endpointId] ?? "Deleted endpoint"}
                </TableCell>
              ) : null}
              <TableCell className="text-fg-secondary">
                <span className="flex items-center gap-2">
                  <ProviderLogo slug={event.provider} size={16} />
                  {providerDisplayName(event.provider)}
                </span>
              </TableCell>
              <TableCell>
                {/* Tri-state (ADR-0077 amendment): the list projects the verification state, so a genuine
                    signature FAILURE shows red. "Not verified" (unattempted) stays neutral — it collapses
                    no-secret / header-absent / KMS-error, none of which is a failure. */}
                {(() => {
                  const pill = verificationStatePill(event.verificationState, event.verified);
                  return <StatusPill tone={pill.tone}>{pill.label}</StatusPill>;
                })()}
              </TableCell>
              <TableCell>
                <code className="font-mono text-xs text-fg-secondary">{event.id}</code>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
