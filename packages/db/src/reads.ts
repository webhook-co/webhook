// Tenant read repos for the read-capabilities surface (endpoints.list/get, events.list/get).
// Each runs inside a caller-supplied tenant tx (see withTenant), so RLS pins the org and
// these queries never filter by org_id themselves — an unset context returns zero rows
// (deny-by-default), and a cross-org id simply isn't visible. snake_case columns map to the
// shared camelCase entity schemas, which also validate the row shape.

import {
  deriveVerificationState,
  DeliverySchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  LISTEN_LAG_CAP,
  WATERMARK_DELTA_MS,
  type Cursor,
  type Delivery,
  type Endpoint,
  type Event,
  type EventSummary,
  type Since,
  type VerificationState,
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

// The opaque Cursor carries a (timestamp, id) keyset position. `orderKey` is the order timestamp as a UTC
// ISO-8601 MICROSECOND string — events order on `received_at`, endpoints/deliveries on `created_at`; the
// field is generic to the cursor, not tied to one column.
//
// Precision: the cursor carries FULL microsecond precision (a UTC ISO-µs string projected by `orderKeyCol`
// via `to_char(<col> at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), so the keyset compares the RAW
// `<col>` against `${orderKey}::text::timestamptz` at exact µs — which a plain btree on `(…, <col>, id)` serves.
// ⚠️ The `::text` is load-bearing: bound directly as `${orderKey}::timestamptz`, postgres.js infers the param
// type as timestamptz and serializes the string through a MILLISECOND path (dropping the µs) — reintroducing
// the same-ms dup/stall. Forcing `::text` makes it bind the raw string, so Postgres parses the full µs.
// (The old design truncated everything to `date_trunc('milliseconds', <col>)` to match a ms-only cursor,
// but that STABLE expression can't back an index — see ADR-0087 follow-up / migration 0036.) The `id`
// tiebreaker orders same-instant rows. The cursor key is a STRING, never a JS `Date` (Date is ms-only and
// would silently truncate the µs the keyset depends on). The watermark filter stays on the raw `received_at`.

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

/** An item paired with its own exact keyset cursor — for the listen tunnel, which emits a cursor PER event
 *  so a client can ack/resume from any single event (not just the page boundary). */
export interface ItemWithCursor<T> {
  readonly item: T;
  readonly cursor: Cursor;
}

/** Like {@link buildPage} but each kept item carries its own cursor (built from the SAME `cursorOf`). */
function buildPageWithCursors<R, T>(
  rows: readonly R[],
  limit: number,
  mapItem: (row: R) => T,
  cursorOf: (row: R) => Cursor,
): Page<ItemWithCursor<T>> {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ item: mapItem(r), cursor: cursorOf(r) })),
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
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

// The µs-exact keyset on the RAW received_at (indexable by events_tunnel_idx), with `id` as the stable
// tiebreaker. The cursor's `orderKey` (UTC ISO-µs text) binds as `::timestamptz` — lossless at µs. Forward
// tail uses `>` (events strictly after the resume position); the newest-first browse uses `<`. Returns the
// leading `and …` so the call site stays `${cursor ? keysetAfter(tx, cursor) : tx``}`.
function keysetAfter(tx: TenantTx, c: Cursor) {
  return tx`and (received_at, id) > (${c.orderKey}::text::timestamptz, ${c.id}::uuid)`;
}
function keysetBefore(tx: TenantTx, c: Cursor) {
  return tx`and (received_at, id) < (${c.orderKey}::text::timestamptz, ${c.id}::uuid)`;
}

// Project a row's order timestamp as the cursor's UTC ISO-8601 microsecond order key, aliased `order_key`
// (so every keyset read's Row type carries `order_key: string` and `cursorOf` is uniform). UTC-anchored +
// literal "Z" so the reparse via `::timestamptz` is exact regardless of the session TimeZone; `US` always
// emits 6 fractional digits. `col` is a fixed internal literal — never user input.
function orderKeyCol(tx: TenantTx, col: "received_at" | "created_at") {
  return col === "received_at"
    ? tx`to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as order_key`
    : tx`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as order_key`;
}

/** A JS `Date` (ms) → the cursor's 6-digit UTC ISO-µs order key. `toISOString()` is always `…sssZ` (3 frac
 *  digits, UTC), so the trailing-Z swap yields `…sss000Z`. Used for `--since <RFC3339>` boundaries. */
function msDateToOrderKey(d: Date): string {
  return `${d.toISOString().slice(0, -1)}000Z`;
}

// Wrap a user search term as a case-insensitive CONTAINS pattern for `ILIKE`, escaping the LIKE
// metacharacters (\ % _) so the term matches literally — a user typing `50%` searches for "50%", not
// "50<anything>". The term is always a BOUND param (never interpolated), so this is correctness, not an
// injection defense. ILIKE's default escape char is backslash. Shared by the endpoints name filter and
// the events search filter.
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The events.list free-text search. A FULL-uuid term is an exact event-id lookup (the user pasted an
// event id to jump to it) — resolved by the PK alone, NOT OR'd into the substring scans (which would run
// three wasted trigram scans alongside the PK probe; and a non-uuid term must never reach `id =`, which
// would raise 22P02). Any other term is a case-insensitive substring across the ID fields
// (provider_event_id, external_id, dedup_key), backed by trigram GIN indexes (migration 0023). All inputs
// are bound params.
function eventSearchFilter(tx: TenantTx, search: string | undefined) {
  if (!search) return tx``;
  if (UUID_RE.test(search)) return tx`and id = ${search}`;
  const pattern = likeContains(search);
  // The three ID columns are trigram-GIN-indexed (migration 0023). `headers::text` is a RESIDUAL scan
  // (no GIN — indexing the large headers jsonb on the hot ingest path isn't worth the write-amp), and it
  // serializes the whole jsonb so a term matches a header NAME or VALUE.
  //   ⚠️ PERF: Postgres can only bitmap-OR an indexed disjunction when EVERY branch is index-backed, so
  //   adding the unindexed headers branch forgoes the 0023 trigram path for the WHOLE search — it becomes
  //   a per-endpoint seq scan. This is bounded (endpoint_id leads every index; the browse stops at
  //   limit+1 matches) and only bites at very large per-endpoint volumes (where the trigram was the win);
  //   at typical volumes the planner seq-scanned anyway. Revisit with a trigram GIN on (headers::text) if
  //   header-inclusive search becomes hot. Header values aren't EXPOSED by a match — they stay redacted in
  //   the UI; matching only LOCATES the event within the caller's own RLS-scoped org.
  return tx`and (provider_event_id ilike ${pattern} or external_id ilike ${pattern} or dedup_key ilike ${pattern} or headers::text ilike ${pattern})`;
}

interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  paused: boolean;
  created_at: Date;
  /** Projected by listEndpoints via orderKeyCol — the cursor's UTC ISO-µs order key. Absent on getEndpoint. */
  order_key?: string;
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
    select id, org_id, name, paused, created_at, ${orderKeyCol(tx, "created_at")}
    from endpoints
    where deleted_at is null
    ${name ? tx`and name ilike ${likeContains(name)}` : tx``}
    ${cursor ? tx`and (created_at, id) < (${cursor.orderKey}::text::timestamptz, ${cursor.id}::uuid)` : tx``}
    order by created_at desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEndpoint, (r) => ({ orderKey: r.order_key!, id: r.id }));
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
  /** The captured request's HTTP method; NULL on legacy rows captured before accept-all-verbs. */
  method: string | null;
  /** Projected by the summary reads (listEvents/tailEvents) via the SQL CASE; absent on getEvent. */
  verification_state?: string;
  /** Projected by the keyset reads via orderKeyCol — the cursor's UTC ISO-µs order key. Absent on getEvent. */
  order_key?: string;
}

// The truthful verification tri-state, projected in SQL so the lean summary carries it WITHOUT shipping
// the `verification` jsonb. Mirrors deriveVerificationState(). Used by listEvents + tailEvents.
function verificationStateColumn(tx: TenantTx) {
  return tx`case when verified and verification->>'authenticity' is not null then 'authenticated' when verified then 'verified' when verification is not null then 'failed' else 'unattempted' end as verification_state`;
}

// One verification-state bucket's predicate. MIRRORS its verificationStateColumn() CASE bucket EXACTLY
// (incl. the `not verified` guard on `unattempted`) so a filtered row's pill can never contradict the
// filter — even if a future row ever had verified=true with a null verification (which the CASE would
// label 'verified', not 'unattempted').
function verificationStatePredicate(tx: TenantTx, state: VerificationState) {
  // `verified` now EXCLUDES the weaker `authenticated` (token/basic) bucket so a filtered row's pill can't
  // contradict the filter — they're disjoint on `verification->>'authenticity'`.
  if (state === "authenticated")
    return tx`(verified and verification->>'authenticity' is not null)`;
  if (state === "verified") return tx`(verified and verification->>'authenticity' is null)`;
  if (state === "failed") return tx`(not verified and verification is not null)`;
  return tx`(not verified and verification is null)`; // unattempted
}

// The events.list verification-state filter — multi-select, so the selected buckets are OR'd
// (`and (verified or (not verified and verification is not null))`). Empty/undefined = no filter; the
// `failed` bucket alone is backed by events_failed_idx (migration 0022), a mixed selection rides the
// per-endpoint scan as a residual filter (the verified/unattempted buckets are intentionally unindexed).
function verificationStateFilter(tx: TenantTx, states: readonly VerificationState[] | undefined) {
  const unique = states ? [...new Set(states)] : [];
  if (unique.length === 0) return tx``;
  const joined = unique
    .map((state) => verificationStatePredicate(tx, state))
    .reduce((acc, predicate) => tx`${acc} or ${predicate}`);
  return tx`and (${joined})`;
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
    verificationState: r.verification_state,
  });
}

export interface ListEventsOptions extends ListOptions {
  readonly endpointId: string;
  /** Multi-select provider filter — OR'd (`provider = ANY`). Empty/undefined = no filter. */
  readonly provider?: readonly string[];
  /** Inclusive lower bound on received_at (events at or after this instant). */
  readonly receivedAfter?: Date;
  /** Exclusive upper bound on received_at (events strictly before this instant). */
  readonly receivedBefore?: Date;
  /** Multi-select verification tri-state filter (verified | failed | unattempted) — OR'd. */
  readonly verificationState?: readonly VerificationState[];
  /** Case-insensitive substring across the event ID fields + headers (+ exact id match when a uuid). */
  readonly search?: string;
}

export async function listEvents(
  tx: TenantTx,
  opts: ListEventsOptions,
): Promise<Page<EventSummary>> {
  const limit = clampLimit(opts.limit);
  const { cursor, endpointId, provider, receivedAfter, receivedBefore, verificationState, search } =
    opts;
  // The received-at range + keyset are bound on the RAW received_at (sargable against events_tunnel_idx,
  // which leads with endpoint_id then received_at, id) — the range narrows the per-endpoint scan, the keyset
  // seeks the page and orders it (backward scan for DESC), no Sort node. The sparse `failed` verification
  // filter is backed by the events_failed_idx partial index (migration 0022).
  const rows = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified,
           ${verificationStateColumn(tx)}, ${orderKeyCol(tx, "received_at")}
    from events
    where endpoint_id = ${endpointId}
    ${provider && provider.length > 0 ? tx`and provider in ${tx([...provider])}` : tx``}
    ${receivedAfter ? tx`and received_at >= ${receivedAfter}` : tx``}
    ${receivedBefore ? tx`and received_at < ${receivedBefore}` : tx``}
    ${verificationStateFilter(tx, verificationState)}
    ${eventSearchFilter(tx, search)}
    ${cursor ? keysetBefore(tx, cursor) : tx``}
    order by received_at desc, id desc
    limit ${limit + 1}`;

  return buildPage(rows, limit, toEventSummary, (r) => ({ orderKey: r.order_key!, id: r.id }));
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
// filter stays on the RAW received_at (µs) — the gapless proof needs δ to be exactly the timeout. The keyset
// is now ALSO on the raw received_at (the cursor carries exact µs), so both ride events_tunnel_idx
// (endpoint_id, received_at, id) — a forward scan for this ASC tail.
async function tailEventRows(tx: TenantTx, opts: TailEventsOptions): Promise<EventRow[]> {
  const limit = clampLimit(opts.limit);
  const { endpointId, sinceCursor } = opts;
  return tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified,
           ${verificationStateColumn(tx)}, ${orderKeyCol(tx, "received_at")}
    from events
    where endpoint_id = ${endpointId}
      and ${belowWatermark(tx)}
      ${sinceCursor ? keysetAfter(tx, sinceCursor) : tx``}
    order by received_at asc, id asc
    limit ${limit + 1}`;
}

const tailCursorOf = (r: EventRow): Cursor => ({ orderKey: r.order_key!, id: r.id });

export async function tailEvents(
  tx: TenantTx,
  opts: TailEventsOptions,
): Promise<Page<EventSummary>> {
  return buildPage(
    await tailEventRows(tx, opts),
    clampLimit(opts.limit),
    toEventSummary,
    tailCursorOf,
  );
}

/**
 * The listen tunnel's tail: same rows as {@link tailEvents}, but each item is paired with its own EXACT-µs
 * cursor. The tunnel encodes a cursor per event frame so a client can ack/resume from any single event — the
 * per-event cursor MUST be full µs (a ms-truncated ack of an event with a sub-ms fraction would re-deliver it
 * on resume, since the keyset now compares the raw received_at).
 */
export async function tailEventsWithCursors(
  tx: TenantTx,
  opts: TailEventsOptions,
): Promise<Page<ItemWithCursor<EventSummary>>> {
  return buildPageWithCursors(
    await tailEventRows(tx, opts),
    clampLimit(opts.limit),
    toEventSummary,
    tailCursorOf,
  );
}

/**
 * The cursor of the LATEST event at/below the gapless watermark for an endpoint, or null if there is
 * none — the "current position" a `?since=now` listen session starts from, so it tails only NEW events
 * and skips the backlog. (The cli-only seed can't get this: events.tail returns no cursor when caught
 * up.) Same watermark as tailEvents, ordered DESC on the raw received_at to take the max (received_at, id)
 * at exact µs. Backed by events_tunnel_idx (endpoint_id, received_at, id).
 */
export async function latestTailCursor(
  tx: TenantTx,
  opts: { readonly endpointId: string },
): Promise<Cursor | null> {
  const [r] = await tx<{ order_key: string; id: string }[]>`
    select ${orderKeyCol(tx, "received_at")}, id
    from events
    where endpoint_id = ${opts.endpointId}
      and ${belowWatermark(tx)}
    order by received_at desc, id desc
    limit 1`;
  return r ? { orderKey: r.order_key, id: r.id } : null;
}

/**
 * Head + backlog metadata for an endpoint's forward tail, computed in ONE tenant tx (under RLS).
 * `headCursor` is the watermark-bounded latest (= latestTailCursor — NEVER raw MAX, which sits above
 * the gapless watermark; an exclusive resume from a raw MAX would skip late-but-valid events).
 * `backlogCount` is the count of unseen events at/below the watermark strictly after `sinceCursor`
 * (the full visible backlog when omitted), CAPPED at `cap` via `limit cap + 1` in SQL — a returned
 * value of `cap + 1` means "more than cap". The COUNT bounds on the RAW watermark + the lower µs-keyset
 * ONLY, never an upper bound on `headCursor`. Same window + raw-µs keyset as tailEvents; backed by
 * events_tunnel_idx.
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
 * boundary `(T, ZERO_UUID)` rides the existing `tailEvents` keyset, so "T before the earliest" naturally
 * yields everything (= beginning) and "T in the future / past the watermark" yields nothing (= resume
 * live) — the clamp emerges from the keyset + watermark, needing no extra query or index. `<RFC3339>` uses
 * the parsed instant (a ms Date → `.sss000Z` µs order key); `<duration>` resolves now() minus the duration
 * against the DB clock (skew-safe) as a µs order key. `beginning` → no cursor (oldest-inclusive). `now` is
 * the ONE mode that must skip the ENTIRE backlog (only NEW events), so it resolves to the actual watermark
 * head (`latestTailCursor`, µs-exact): exclusive of the head excludes every backlog row (no same-ms
 * re-surface — the µs head is exact), and it's gapless for live tailing (future events get monotonic
 * UUIDv7 ids > head). ZERO_UUID sorts below every UUIDv7, so `(T, ZERO_UUID)` with `>` includes every real
 * event at instant T. Resolve once at start, iterate by cursor.
 */
export async function resolveSince(
  tx: TenantTx,
  opts: { readonly endpointId: string; readonly since: Exclude<Since, { kind: "invalid" }> },
): Promise<Cursor | undefined> {
  const { endpointId, since } = opts;
  if (since.kind === "beginning") return undefined;
  if (since.kind === "now") return (await latestTailCursor(tx, { endpointId })) ?? undefined;
  if (since.kind === "timestamp") return { orderKey: msDateToOrderKey(since.date), id: ZERO_UUID };
  const [row] = await tx<{ t: string }[]>`
    select to_char((now() - (${since.ms} * interval '1 millisecond')) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  return { orderKey: row!.t, id: ZERO_UUID };
}

export async function getEvent(tx: TenantTx, id: string): Promise<Event | null> {
  const [r] = await tx<EventRow[]>`
    select id, org_id, endpoint_id, received_at, provider, dedup_key, dedup_strategy, verified,
           payload_r2_key, payload_bytes, content_type, headers, provider_event_id, external_id,
           verification, method
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
    // Derived in JS here (getEvent selects the `verification` jsonb, unlike the lean summary reads
    // that project the SQL CASE) so events.get reports the same tri-state as the list.
    verificationState: deriveVerificationState(r.verified, r.verification),
    payloadR2Key: r.payload_r2_key,
    payloadBytes: Number(r.payload_bytes),
    contentType: r.content_type,
    headers: r.headers,
    providerEventId: r.provider_event_id,
    externalId: r.external_id,
    verification: r.verification,
    method: r.method,
  });
}

// ── Deliveries (S3 Slice 3 PR3) — the auto-delivery observability reads over delivery_attempts ────────
// The tenant-facing view of a delivery_attempts row: the routing link (destination_id, subscription_id) +
// the retry clock (attempt, next_retry_at) + the outcome (status, status_code, error). Distinct from the
// DO's claim/finalize seam (packages/db/src/delivery.ts) and the remote-replay writer
// (packages/db/src/replay.ts) — those mutate; these READ under the caller's RLS tx.

interface DeliveryRow {
  id: string;
  event_id: string;
  destination_id: string | null;
  subscription_id: string | null;
  status: string;
  status_code: number | null;
  attempt: number;
  error: string | null;
  next_retry_at: Date | null;
  created_at: Date;
  /** Projected by listDeliveries via orderKeyCol — the cursor's UTC ISO-µs order key. Absent on getDelivery. */
  order_key?: string;
}

const DELIVERY_COLS =
  "id, event_id, destination_id, subscription_id, status, status_code, attempt, error, next_retry_at, created_at";

function toDelivery(r: DeliveryRow): Delivery {
  return DeliverySchema.parse({
    id: r.id,
    eventId: r.event_id,
    destinationId: r.destination_id,
    subscriptionId: r.subscription_id,
    status: r.status,
    statusCode: r.status_code,
    attempt: r.attempt,
    error: r.error,
    nextRetryAt: r.next_retry_at,
    createdAt: r.created_at,
  });
}

/** Resolve one delivery by id under RLS (deliveries.get). Cross-org / unknown → null (no existence oracle). */
export async function getDelivery(tx: TenantTx, id: string): Promise<Delivery | null> {
  const [r] = await tx<DeliveryRow[]>`
    select ${tx.unsafe(DELIVERY_COLS)} from delivery_attempts where id = ${id}`;
  return r ? toDelivery(r) : null;
}

export interface ListDeliveriesOptions extends ListOptions {
  /** Filter to one destination's deliveries. */
  readonly destinationId?: string;
  /** Filter to one subscription's deliveries (excludes manual-replay rows, which carry no subscription). */
  readonly subscriptionId?: string;
  /** Multi-select status filter — OR'd (`status in (...)`). Empty/undefined = no filter. */
  readonly status?: readonly string[];
}

/**
 * The org's deliveries, newest-first, paginated (deliveries.list). All filters are optional and AND together;
 * a cross-org/unknown destinationId or subscriptionId simply yields an empty page under RLS (no existence
 * oracle). Keyset on the RAW `created_at` (the DO stamps a fresh row per delivery) at exact µs, with `id` as
 * the tiebreaker — mirrors listEndpoints. Backed by the migration-0036 covering indexes: org-wide →
 * delivery_attempts_org_ordered_idx (org_id, created_at, id); `destinationId` filter →
 * delivery_attempts_destination_ordered_idx (destination_id, created_at, id); `subscriptionId` filter →
 * delivery_attempts_subscription_ordered_idx (subscription_id, created_at, id) partial.
 */
export async function listDeliveries(
  tx: TenantTx,
  opts: ListDeliveriesOptions = {},
): Promise<Page<Delivery>> {
  const limit = clampLimit(opts.limit);
  const { cursor, destinationId, subscriptionId, status } = opts;
  const rows = await tx<DeliveryRow[]>`
    select ${tx.unsafe(DELIVERY_COLS)}, ${orderKeyCol(tx, "created_at")}
    from delivery_attempts
    where true
    ${destinationId ? tx`and destination_id = ${destinationId}` : tx``}
    ${subscriptionId ? tx`and subscription_id = ${subscriptionId}` : tx``}
    ${status && status.length > 0 ? tx`and status in ${tx([...status])}` : tx``}
    ${cursor ? tx`and (created_at, id) < (${cursor.orderKey}::text::timestamptz, ${cursor.id}::uuid)` : tx``}
    order by created_at desc, id desc
    limit ${limit + 1}`;
  return buildPage(rows, limit, toDelivery, (r) => ({ orderKey: r.order_key!, id: r.id }));
}
