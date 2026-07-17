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
  /** Empty-state copy when nothing is filtered. The two browses onboard differently. */
  readonly emptyMessage: string;
}

/**
 * The events table: rows only, no paging and no live tail.
 *
 * Presentational and state-free, so the endpoint-scoped list and the org-wide one render IDENTICAL rows and
 * cannot drift on the columns, the link shape, or the verification pill.
 *
 * An Endpoint column belongs here once the org-wide browse exists — it is deliberately NOT here yet. It
 * needs `EndpointMeta {name, deleted}` (server/events.ts), whose absence-vs-deleted distinction a naive
 * `Record<string, string>` would flatten: an endpoint can be missing from a name map because the map was
 * built with a name FILTER, because `loadEndpoints` errored, or because the live tail prepended an event for
 * an endpoint created after the page rendered — none of which mean "deleted". It lands with its producer.
 */
export function EventsTable({ items, isFiltered, emptyMessage }: EventsTableProps) {
  // The org this is rendered in — read from the URL, which is the source of truth for it.
  const slug = useOrgSlug();

  return (
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
