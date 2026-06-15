// Tenant read repos for the read-capabilities surface (endpoints.list/get, events.list/get).
// Each runs inside a caller-supplied tenant tx (see withTenant), so RLS pins the org and
// these queries never filter by org_id themselves — an unset context returns zero rows
// (deny-by-default), and a cross-org id simply isn't visible. snake_case columns map to the
// shared camelCase entity schemas, which also validate the row shape.

import {
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  type Cursor,
  type Endpoint,
  type Event,
  type EventSummary,
} from "@webhook-co/shared";

import type { TenantTx } from "./client";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A page of items plus the keyset cursor to fetch the next page (null when exhausted). */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: Cursor | null;
}

export interface ListOptions {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

// The opaque Cursor carries a (timestamp, id) keyset position. `receivedAt` is the order
// timestamp — events order on the column `received_at`, endpoints on `created_at`; the field
// name is generic to the cursor, not tied to a single column.
//
// Precision note: the cursor and the postgres driver round timestamps to MILLISECONDS (a JS Date
// has ms resolution, both on parse and on bind), but the timestamp columns are stored at MICROSECOND
// precision. So every keyset compares and orders on `date_trunc('milliseconds', <col>)` to match the
// cursor's resolution. Without it, a boundary row whose sub-ms fraction is non-zero compares strictly
// greater/less than its own truncated cursor — forward that re-emits the row forever (dup/stall),
// backward it skips a same-ms neighbour. The `id` tiebreaker then gives a stable total order within a
// millisecond. (The watermark filter stays on the raw `received_at` so its µs-tight invariant holds.)

// Shared keyset page builder: the repos fetch `limit + 1` rows; if the extra row is present
// there's a next page, and the next cursor is the last KEPT row's keyset position. One place
// so every list (endpoints, events, and the future events.tail) can't drift on the math.
function buildPage<R, T>(
  rows: readonly R[],
  limit: number,
  mapItem: (row: R) => T,
  cursorOf: (row: R) => Cursor,
): Page<T> {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(mapItem), nextCursor: hasMore && last ? cursorOf(last) : null };
}

interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  paused: boolean;
  created_at: Date;
}

function toEndpoint(r: EndpointRow): Endpoint {
  return EndpointSchema.parse({
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    paused: r.paused,
    createdAt: r.created_at,
  });
}

export async function listEndpoints(tx: TenantTx, opts: ListOptions = {}): Promise<Page<Endpoint>> {
  const limit = clampLimit(opts.limit);
  const cursor = opts.cursor;
  const rows = await tx<EndpointRow[]>`
    select id, org_id, name, paused, created_at
    from endpoints
    ${cursor ? tx`where (date_trunc('milliseconds', created_at), id) < (${cursor.receivedAt}::timestamptz, ${cursor.id}::uuid)` : tx``}
    order by date_trunc('milliseconds', created_at) desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEndpoint, (r) => ({ receivedAt: r.created_at, id: r.id }));
}

export async function getEndpoint(tx: TenantTx, id: string): Promise<Endpoint | null> {
  const [row] = await tx<EndpointRow[]>`
    select id, org_id, name, paused, created_at from endpoints where id = ${id}`;
  return row ? toEndpoint(row) : null;
}

interface EventRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  received_at: Date;
  provider: string | null;
  dedup_key: string;
  dedup_strategy: string;
  verified: boolean;
  payload_r2_key: string;
  payload_bytes: string | number;
  content_type: string | null;
  headers: unknown;
  provider_event_id: string | null;
  external_id: string | null;
  verification: unknown;
}

function toEventSummary(r: EventRow): EventSummary {
  return EventSummarySchema.parse({
    id: r.id,
    orgId: r.org_id,
    endpointId: r.endpoint_id,
    receivedAt: r.received_at,
    provider: r.provider,
    dedupKey: r.dedup_key,
    dedupStrategy: r.dedup_strategy,
    verified: r.verified,
  });
}

export interface ListEventsOptions extends ListOptions {
  readonly endpointId: string;
  readonly provider?: string;
}

export async function listEvents(
  tx: TenantTx,
  opts: ListEventsOptions,
): Promise<Page<EventSummary>> {
  const limit = clampLimit(opts.limit);
  const { cursor, endpointId, provider } = opts;
  const rows = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified
    from events
    where endpoint_id = ${endpointId}
    ${provider ? tx`and provider = ${provider}` : tx``}
    ${cursor ? tx`and (date_trunc('milliseconds', received_at), id) < (${cursor.receivedAt}::timestamptz, ${cursor.id}::uuid)` : tx``}
    order by date_trunc('milliseconds', received_at) desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEventSummary, (r) => ({ receivedAt: r.received_at, id: r.id }));
}

export interface TailEventsOptions {
  readonly endpointId: string;
  /** Resume position; the scan returns rows strictly AFTER it (omit to start from the oldest). */
  readonly sinceCursor?: Cursor;
  /** The newest received_at the tail may return — the caller passes watermarkCutoff(now). */
  readonly watermarkCutoff: Date;
  readonly limit?: number;
}

// The forward sibling of listEvents: a watermark-bounded tail. Where listEvents browses newest-first
// (received_at DESC, < cursor), the tail reads oldest-first (received_at ASC, > cursor) so a consumer
// advances chronologically, and it only returns rows at or before the watermark cutoff. The cutoff is
// what makes the tail gapless on resume: an in-flight ingest (statement_timeout = WATERMARK_DELTA_MS)
// cannot commit a row with a received_at older than now - δ, so once a cursor passes the watermark no
// later-committed row can fall behind it. Backed by events_tunnel_idx (endpoint_id, received_at, id).
export async function tailEvents(
  tx: TenantTx,
  opts: TailEventsOptions,
): Promise<Page<EventSummary>> {
  const limit = clampLimit(opts.limit);
  const { endpointId, sinceCursor, watermarkCutoff } = opts;
  const rows = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified
    from events
    where endpoint_id = ${endpointId}
      and received_at <= ${watermarkCutoff}::timestamptz
      ${sinceCursor ? tx`and (date_trunc('milliseconds', received_at), id) > (${sinceCursor.receivedAt}::timestamptz, ${sinceCursor.id}::uuid)` : tx``}
    order by date_trunc('milliseconds', received_at) asc, id asc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEventSummary, (r) => ({ receivedAt: r.received_at, id: r.id }));
}

export async function getEvent(tx: TenantTx, id: string): Promise<Event | null> {
  const [r] = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified,
           payload_r2_key, payload_bytes, content_type, headers, provider_event_id, external_id,
           verification
    from events where id = ${id}`;
  if (!r) return null;
  return EventSchema.parse({
    id: r.id,
    orgId: r.org_id,
    endpointId: r.endpoint_id,
    receivedAt: r.received_at,
    provider: r.provider,
    dedupKey: r.dedup_key,
    dedupStrategy: r.dedup_strategy,
    verified: r.verified,
    payloadR2Key: r.payload_r2_key,
    payloadBytes: Number(r.payload_bytes),
    contentType: r.content_type,
    headers: r.headers,
    providerEventId: r.provider_event_id,
    externalId: r.external_id,
    verification: r.verification,
  });
}
