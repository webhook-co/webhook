// Tenant read repos for the read-capabilities surface (endpoints.list/get, events.list/get).
// Each runs inside a caller-supplied tenant tx (see withTenant), so RLS pins the org and
// these queries never filter by org_id themselves — an unset context returns zero rows
// (deny-by-default), and a cross-org id simply isn't visible. snake_case columns map to the
// shared camelCase entity schemas, which also validate the row shape.

import {
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  LISTEN_LAG_CAP,
  WATERMARK_DELTA_MS,
  type Cursor,
  type Endpoint,
  type Event,
  type EventSummary,
  type Since,
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

// The two load-bearing event-read predicates, defined ONCE so the four event reads (listEvents,
// tailEvents, latestTailCursor, tailMeta) can't drift apart on the ms-on-wire / µs-in-rows seam.
// These are the silent-gap surface: a stray change here (truncating the watermark, flipping an
// operator, dropping a cast) reintroduces a gap without failing an obvious test, so they live in one
// place under one comment.

// The gapless watermark, bound on the RAW received_at (µs). δ must be EXACTLY the ingest
// statement_timeout, so this stays un-truncated (unlike the keyset) — see the precision note above.
function belowWatermark(tx: TenantTx) {
  return tx`received_at <= now() - (${WATERMARK_DELTA_MS} * interval '1 millisecond')`;
}

// The ms-resolution keyset on received_at — date_trunc('milliseconds', …) to match the cursor's
// resolution, with `id` as the stable tiebreaker. Forward tail uses `>` (events strictly after the
// resume position); the newest-first browse uses `<`. Returns the leading `and …` so the call site
// stays `${cursor ? keysetAfter(tx, cursor) : tx``}`.
function keysetAfter(tx: TenantTx, c: Cursor) {
  return tx`and (date_trunc('milliseconds', received_at), id) > (${c.receivedAt}::timestamptz, ${c.id}::uuid)`;
}
function keysetBefore(tx: TenantTx, c: Cursor) {
  return tx`and (date_trunc('milliseconds', received_at), id) < (${c.receivedAt}::timestamptz, ${c.id}::uuid)`;
}

// Wrap a user search term as a case-insensitive CONTAINS pattern for `ILIKE`, escaping the LIKE
// metacharacters (\ % _) so the term matches literally — a user typing `50%` searches for "50%", not
// "50<anything>". The term is always a BOUND param (never interpolated), so this is correctness, not an
// injection defense. ILIKE's default escape char is backslash. Shared by the endpoints name filter and
// the events search filter.
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
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

export interface ListEndpointsOptions extends ListOptions {
  /** Optional case-insensitive substring filter on the endpoint name (unindexed; the set is small). */
  readonly name?: string;
}

export async function listEndpoints(
  tx: TenantTx,
  opts: ListEndpointsOptions = {},
): Promise<Page<Endpoint>> {
  const limit = clampLimit(opts.limit);
  const { cursor, name } = opts;
  // `deleted_at is null` hides soft-deleted endpoints (ADR-0076) from endpoints.list.
  const rows = await tx<EndpointRow[]>`
    select id, org_id, name, paused, created_at
    from endpoints
    where deleted_at is null
    ${name ? tx`and name ilike ${likeContains(name)}` : tx``}
    ${cursor ? tx`and (date_trunc('milliseconds', created_at), id) < (${cursor.receivedAt}::timestamptz, ${cursor.id}::uuid)` : tx``}
    order by date_trunc('milliseconds', created_at) desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEndpoint, (r) => ({ receivedAt: r.created_at, id: r.id }));
}

/**
 * Resolve one endpoint by id under RLS. By default a soft-deleted endpoint reads as not-found (ADR-0076),
 * so the `endpoints.get` capability 404s after a delete. `includeDeleted` keeps a soft-deleted endpoint
 * resolvable: the EVENT handlers (events.list / events.tail / events.replay) gate on this — a deleted
 * endpoint's captured events + payloads are RETAINED and stay listable/tailable/replayable by id (the
 * inspection-history rationale soft delete was chosen for), even though the endpoint is hidden from
 * `endpoints.list` / `endpoints.get`.
 */
export async function getEndpoint(
  tx: TenantTx,
  id: string,
  opts: { readonly includeDeleted?: boolean } = {},
): Promise<Endpoint | null> {
  const [row] = await tx<EndpointRow[]>`
    select id, org_id, name, paused, created_at from endpoints
    where id = ${id} ${opts.includeDeleted ? tx`` : tx`and deleted_at is null`}`;
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
  /** Inclusive lower bound on received_at (events at or after this instant). */
  readonly receivedAfter?: Date;
  /** Exclusive upper bound on received_at (events strictly before this instant). */
  readonly receivedBefore?: Date;
}

export async function listEvents(
  tx: TenantTx,
  opts: ListEventsOptions,
): Promise<Page<EventSummary>> {
  const limit = clampLimit(opts.limit);
  const { cursor, endpointId, provider, receivedAfter, receivedBefore } = opts;
  // The received-at range is bound on the RAW received_at (sargable against events_tunnel_idx /
  // events_provider_idx, which lead with endpoint_id then received_at) — it only narrows the per-endpoint
  // scan. The keyset still compares date_trunc('ms', …) to match the cursor resolution.
  const rows = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified
    from events
    where endpoint_id = ${endpointId}
    ${provider ? tx`and provider = ${provider}` : tx``}
    ${receivedAfter ? tx`and received_at >= ${receivedAfter}` : tx``}
    ${receivedBefore ? tx`and received_at < ${receivedBefore}` : tx``}
    ${cursor ? keysetBefore(tx, cursor) : tx``}
    order by date_trunc('milliseconds', received_at) desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEventSummary, (r) => ({ receivedAt: r.received_at, id: r.id }));
}

export interface TailEventsOptions {
  readonly endpointId: string;
  /** Resume position; the scan returns rows strictly AFTER it (omit to start from the oldest). */
  readonly sinceCursor?: Cursor;
  readonly limit?: number;
}

// The forward sibling of listEvents: a watermark-bounded tail. Where listEvents browses newest-first
// (received_at DESC, < cursor), the tail reads oldest-first (received_at ASC, > cursor) so a consumer
// advances chronologically, and it only returns rows at or before the gapless watermark `now() - δ`.
// The watermark is what makes the tail gapless on resume: an in-flight ingest (statement_timeout =
// WATERMARK_DELTA_MS) cannot commit a row with a received_at older than now() - δ, so once a cursor
// passes the watermark no later-committed row can fall behind it.
//
// The cutoff is computed Postgres-side (`now()`), NOT from a caller-supplied Date: received_at is
// stamped by the events trigger with the DB clock, so comparing it to the DB's own now() keeps δ
// exactly the statement_timeout with no Worker↔Postgres clock skew eroding the safety margin. The
// filter stays on the RAW received_at (µs) — the gapless proof needs δ to be exactly the timeout, so
// it must NOT be ms-truncated (unlike the keyset comparison, which matches the ms-resolution cursor).
// Backed by events_tunnel_idx (endpoint_id, received_at, id).
export async function tailEvents(
  tx: TenantTx,
  opts: TailEventsOptions,
): Promise<Page<EventSummary>> {
  const limit = clampLimit(opts.limit);
  const { endpointId, sinceCursor } = opts;
  const rows = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified
    from events
    where endpoint_id = ${endpointId}
      and ${belowWatermark(tx)}
      ${sinceCursor ? keysetAfter(tx, sinceCursor) : tx``}
    order by date_trunc('milliseconds', received_at) asc, id asc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEventSummary, (r) => ({ receivedAt: r.received_at, id: r.id }));
}

/**
 * The cursor of the LATEST event at/below the gapless watermark for an endpoint, or null if there is
 * none — the "current position" a `?since=now` listen session starts from, so it tails only NEW events
 * and skips the backlog. (The cli-only seed can't get this: events.tail returns no cursor when caught
 * up.) Same watermark + ms-resolution keyset as tailEvents, ordered DESC to take the max
 * (received_at, id). Backed by events_tunnel_idx (endpoint_id, received_at, id).
 */
export async function latestTailCursor(
  tx: TenantTx,
  opts: { readonly endpointId: string },
): Promise<Cursor | null> {
  const [r] = await tx<{ received_at: Date; id: string }[]>`
    select received_at, id
    from events
    where endpoint_id = ${opts.endpointId}
      and ${belowWatermark(tx)}
    order by date_trunc('milliseconds', received_at) desc, id desc
    limit 1`;
  return r ? { receivedAt: r.received_at, id: r.id } : null;
}

/**
 * Head + backlog metadata for an endpoint's forward tail, computed in ONE tenant tx (under RLS).
 * `headCursor` is the watermark-bounded latest (= latestTailCursor — NEVER raw MAX, which sits above
 * the gapless watermark; an exclusive resume from a raw MAX would skip late-but-valid events).
 * `backlogCount` is the count of unseen events at/below the watermark strictly after `sinceCursor`
 * (the full visible backlog when omitted), CAPPED at `cap` via `limit cap + 1` in SQL — a returned
 * value of `cap + 1` means "more than cap". The COUNT bounds on the RAW watermark + the lower ms-keyset
 * ONLY, never on the ms-truncated `headCursor` (an upper bound there would drop a same-millisecond µs
 * sibling). Same window + ms-resolution keyset as tailEvents; backed by events_tunnel_idx.
 */
export async function tailMeta(
  tx: TenantTx,
  opts: { readonly endpointId: string; readonly sinceCursor?: Cursor; readonly cap?: number },
): Promise<{ headCursor: Cursor | null; backlogCount: number }> {
  const { endpointId, sinceCursor } = opts;
  const cap = opts.cap ?? LISTEN_LAG_CAP;
  const headCursor = await latestTailCursor(tx, { endpointId });
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from (
      select 1
      from events
      where endpoint_id = ${endpointId}
        and ${belowWatermark(tx)}
        ${sinceCursor ? keysetAfter(tx, sinceCursor) : tx``}
      limit ${cap + 1}
    ) s`;
  return { headCursor, backlogCount: row?.n ?? 0 };
}

// The all-zero UUID sorts below every UUIDv7, so a synthetic boundary `(ms, ZERO_UUID)` with exclusive
// `>` keyset semantics includes EVERY real event at that millisecond (never skips a same-ms sibling).
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolve a parsed `--since` value to a resume cursor server-side, Kinesis-style total function (clamp,
 * never null/throw). For `<duration>`/`<RFC3339>` there is NO time→cursor table lookup: the synthetic
 * boundary `(date_trunc('ms', T), ZERO_UUID)` rides the existing `tailEvents` keyset, so "T before the
 * earliest" naturally yields everything (= beginning) and "T in the future / past the watermark" yields
 * nothing (= resume live) — the clamp emerges from the keyset + watermark, needing no extra query or
 * index. `<RFC3339>` uses the parsed (ms-precision) instant directly; `<duration>` resolves now() minus
 * the duration against the DB clock (skew-safe, ms-truncated). `beginning` → no cursor (oldest-inclusive).
 * `now` is the ONE mode that must skip the ENTIRE backlog (only NEW events), so it resolves to the actual
 * watermark head (`latestTailCursor`): exclusive of the head excludes every backlog row including a
 * same-millisecond one a synthetic watermark-ms boundary would re-surface, and it's gapless for live
 * tailing (future events get monotonic UUIDv7 ids > head). Resolve once at start, iterate by cursor.
 */
export async function resolveSince(
  tx: TenantTx,
  opts: { readonly endpointId: string; readonly since: Exclude<Since, { kind: "invalid" }> },
): Promise<Cursor | undefined> {
  const { endpointId, since } = opts;
  if (since.kind === "beginning") return undefined;
  if (since.kind === "now") return (await latestTailCursor(tx, { endpointId })) ?? undefined;
  if (since.kind === "timestamp") return { receivedAt: since.date, id: ZERO_UUID };
  const [row] = await tx<{ t: Date }[]>`
    select date_trunc('milliseconds', now() - (${since.ms} * interval '1 millisecond')) as t`;
  return { receivedAt: row!.t, id: ZERO_UUID };
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
