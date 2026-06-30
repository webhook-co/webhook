import "server-only";

import { withTenant, type Sql, type TenantTx } from "@webhook-co/db/client";
import { getEndpoint, getEvent, listEvents } from "@webhook-co/db/reads";
import type { Cursor, Event, EventSummary } from "@webhook-co/shared";

import type { EventFilters } from "@/lib/event-filters";
import { isSensitiveHeader } from "@/lib/sensitive-headers";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { isUuid } from "./endpoints";

// The events surfaces for the dashboard. Events are reachable only THROUGH an endpoint (events.list is
// endpoint-scoped). Read live via the Lane reads under withTenant(orgId) as webhook_app; RLS (the
// session orgId) is the tenant backstop, so these queries never filter by org_id themselves and a
// cross-org id simply isn't visible. The browser-safe projections drop orgId (and, on the detail,
// payloadR2Key — an internal R2 pointer that must never reach the client).

/** The list-row shape for the dashboard (events.list) — `EventSummary` minus orgId. */
export type EventSummaryItem = Omit<EventSummary, "orgId">;

/**
 * A captured inbound header for the detail view. A sensitive header (Authorization, signatures,
 * cookies, api keys) is REDACTED server-side — its `value` is null and never reaches the client; the
 * UI fetches it on demand via `revealHeader` (which re-reads the event under RLS). Non-sensitive headers
 * carry their value inline.
 */
export interface DetailHeader {
  readonly name: string;
  readonly value: string | null;
  readonly sensitive: boolean;
}

/**
 * The detail shape (events.get) — `Event` minus orgId and the internal payloadR2Key, with `headers`
 * redacted (sensitive values stripped at the boundary, not shipped to the browser).
 */
export type EventDetailItem = Omit<Event, "orgId" | "payloadR2Key" | "headers"> & {
  readonly headers: readonly DetailHeader[];
};

export type RevealHeaderResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false };

/** Input for revealing one sensitive header value. `endpointId` gives the reveal the same endpoint-scope
 *  guard the page read enforces; `index` addresses the header in the (order-preserving) `headers` array. */
export interface RevealHeaderInput {
  readonly endpointId: string;
  readonly eventId: string;
  readonly index: number;
}

export interface EventsPage {
  readonly items: readonly EventSummaryItem[];
  readonly nextCursor: Cursor | null;
}

/** Endpoint name + whether it is soft-deleted; null when the endpoint doesn't exist in the org at all. */
export interface EndpointMeta {
  readonly name: string;
  readonly deleted: boolean;
}

export type EventsResult =
  | {
      readonly status: "ok";
      readonly endpointName: string;
      readonly deleted: boolean;
      readonly items: readonly EventSummaryItem[];
      readonly nextCursor: Cursor | null;
    }
  | { readonly status: "not_found" }
  | { readonly status: "error" };

export type EventResult =
  | { readonly status: "ok"; readonly event: EventDetailItem }
  | { readonly status: "not_found" }
  | { readonly status: "error" };

/** The reads this surface needs, injectable for tests; the default binds the per-request tenant tx. */
export interface EventReaders {
  /** First page of an endpoint's events (filtered) + its existence/deleted state, in ONE tenant tx. */
  firstPage(
    orgId: string,
    endpointId: string,
    filters?: EventFilters,
  ): Promise<{ meta: EndpointMeta | null; page: EventsPage }>;
  /** A subsequent page (the "Load more" path); existence was established on the first page. The same
   *  filters as the first page must be threaded so paging stays within the active filter set. */
  listEvents(
    orgId: string,
    endpointId: string,
    cursor: Cursor,
    filters?: EventFilters,
  ): Promise<EventsPage>;
  getEvent(orgId: string, eventId: string): Promise<EventDetailItem | null>;
  /** The raw value of a SENSITIVE header (re-read under RLS); null if the endpoint/event/header is absent
   *  or the header isn't sensitive. */
  revealHeader(orgId: string, input: RevealHeaderInput): Promise<{ value: string } | null>;
}

/** Project the db `EventSummary` to the browser-safe item (drops orgId — never serialized to props). */
function toSummaryItem(e: EventSummary): EventSummaryItem {
  return {
    id: e.id,
    endpointId: e.endpointId,
    receivedAt: e.receivedAt,
    provider: e.provider,
    dedupKey: e.dedupKey,
    dedupStrategy: e.dedupStrategy,
    verified: e.verified,
    verificationState: e.verificationState,
  };
}

/** Project the db `Event` to the browser-safe detail item (drops orgId AND payloadR2Key). */
function toDetailItem(e: Event): EventDetailItem {
  return {
    id: e.id,
    endpointId: e.endpointId,
    receivedAt: e.receivedAt,
    provider: e.provider,
    dedupKey: e.dedupKey,
    dedupStrategy: e.dedupStrategy,
    verified: e.verified,
    payloadBytes: e.payloadBytes,
    contentType: e.contentType,
    // Flows through to the client props; the dashboard renders it in S1 (recording it is this slice).
    method: e.method,
    // Redact sensitive header values at the boundary — they never reach the client props (the UI reveals
    // them on demand via revealHeader). Non-sensitive values pass through inline. MUST stay order- and
    // length-preserving (a plain .map): the client reveals by array index, which revealHeader resolves
    // against the same raw e.headers — filtering/sorting here would desync the two and reveal the wrong
    // header.
    headers: e.headers.map(([name, value]) => {
      const sensitive = isSensitiveHeader(name);
      return { name, value: sensitive ? null : value, sensitive };
    }),
    providerEventId: e.providerEventId,
    externalId: e.externalId,
    verification: e.verification,
  };
}

/**
 * Resolve an event under RLS, scoped to its endpoint — the shared cross-endpoint guard for the reveal and
 * payload reads. `getEvent` is org-scoped only (RLS), so an event reached under the wrong `[id]` path
 * resolves to null here. One place to tighten if endpoint-scoping ever changes.
 */
export async function getEventForEndpoint(
  tx: TenantTx,
  endpointId: string,
  eventId: string,
): Promise<Event | null> {
  const e = await getEvent(tx, eventId);
  return e && e.endpointId === endpointId ? e : null;
}

function boundReaders(app: Sql): EventReaders {
  return {
    firstPage: (orgId, endpointId, filters) =>
      withTenant(app, orgId, async (tx) => {
        // One endpoint read in the common (live) case; a second only to tell soft-deleted from absent
        // (getEndpoint doesn't return deleted_at). includeDeleted keeps a soft-deleted endpoint's
        // retained events inspectable (ADR-0076), flagged `deleted` for the banner.
        const live = await getEndpoint(tx, endpointId);
        let meta: EndpointMeta | null;
        if (live) {
          meta = { name: live.name, deleted: false };
        } else {
          const withDeleted = await getEndpoint(tx, endpointId, { includeDeleted: true });
          meta = withDeleted ? { name: withDeleted.name, deleted: true } : null;
        }
        if (!meta) return { meta: null, page: { items: [], nextCursor: null } };
        // No limit → the shared DB default (clampLimit) so the page size can't drift from other surfaces.
        const page = await listEvents(tx, { endpointId, ...filters });
        return {
          meta,
          page: { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor },
        };
      }),
    listEvents: (orgId, endpointId, cursor, filters) =>
      withTenant(app, orgId, async (tx) => {
        const page = await listEvents(tx, { endpointId, cursor, ...filters });
        return { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor };
      }),
    getEvent: (orgId, eventId) =>
      withTenant(app, orgId, async (tx) => {
        const e = await getEvent(tx, eventId);
        return e ? toDetailItem(e) : null;
      }),
    revealHeader: (orgId, { endpointId, eventId, index }) =>
      withTenant(app, orgId, async (tx) => {
        const e = await getEventForEndpoint(tx, endpointId, eventId);
        if (!e) return null;
        const header = e.headers[index];
        if (!header) return null;
        const [name, value] = header;
        // Only a SENSITIVE header is revealable via this path (a non-sensitive value is already inline).
        // `index` maps 1:1 to the redacted projection the client rendered (toDetailItem is order-preserving).
        return isSensitiveHeader(name) ? { value } : null;
      }),
  };
}

/**
 * Load an endpoint's first page of events (newest-first) for the dashboard list. A non-uuid or unknown
 * endpoint id reads as `{status:"not_found"}` (the page 404s); a db fault is `{status:"error"}` (logged).
 * A soft-deleted endpoint still resolves (its events are retained) and is flagged `deleted` for the
 * inspection banner. Tests inject `readers` and skip the pool.
 */
export async function loadEvents(
  orgId: string,
  endpointId: string,
  filters?: EventFilters,
  readers?: EventReaders,
): Promise<EventsResult> {
  if (!isUuid(endpointId)) return { status: "not_found" };
  if (readers) return readEvents(orgId, endpointId, filters, readers);
  return withTenantDb((app) => readEvents(orgId, endpointId, filters, boundReaders(app)));
}

async function readEvents(
  orgId: string,
  endpointId: string,
  filters: EventFilters | undefined,
  r: EventReaders,
): Promise<EventsResult> {
  try {
    const { meta, page } = await r.firstPage(orgId, endpointId, filters);
    if (!meta) return { status: "not_found" };
    return {
      status: "ok",
      endpointName: meta.name,
      deleted: meta.deleted,
      items: page.items,
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    logActionError("events.list_failed", error);
    return { status: "error" };
  }
}

/**
 * Fetch one more page of an endpoint's events (the "Load more" path). The endpoint's existence was
 * already established when the first page rendered, and RLS scopes the read to the caller's own events,
 * so this skips the existence gate. Tests inject `readers`.
 */
export async function loadMoreEvents(
  orgId: string,
  endpointId: string,
  cursor: Cursor,
  filters?: EventFilters,
  readers?: EventReaders,
): Promise<EventsPage> {
  if (readers) return readers.listEvents(orgId, endpointId, cursor, filters);
  return withTenantDb((app) => boundReaders(app).listEvents(orgId, endpointId, cursor, filters));
}

/**
 * Reveal one sensitive header's value (the detail view's click-to-reveal). Re-reads the event under RLS
 * and returns the raw value at `index` only if that header is sensitive — so a secret leaves the server
 * one explicit reveal at a time, never in the page payload. Returns null if the event/header is absent or
 * the header isn't sensitive. Tests inject `readers`.
 */
export async function revealHeader(
  orgId: string,
  input: RevealHeaderInput,
  readers?: EventReaders,
): Promise<{ value: string } | null> {
  if (readers) return readers.revealHeader(orgId, input);
  return withTenantDb((app) => boundReaders(app).revealHeader(orgId, input));
}

/**
 * Load one event by id for the detail page. A non-uuid id, or an unknown / cross-org event, reads as
 * `{status:"not_found"}` (the page 404s); a db fault is `{status:"error"}` (logged). `getEvent` resolves
 * by event id alone under RLS (it is NOT endpoint-scoped), so we additionally assert the event belongs to
 * THIS endpoint — an event from another of the org's endpoints under the wrong `[id]` path 404s.
 */
export async function loadEvent(
  orgId: string,
  endpointId: string,
  eventId: string,
  readers?: EventReaders,
): Promise<EventResult> {
  if (!isUuid(endpointId) || !isUuid(eventId)) return { status: "not_found" };
  if (readers) return readEvent(orgId, endpointId, eventId, readers);
  return withTenantDb((app) => readEvent(orgId, endpointId, eventId, boundReaders(app)));
}

async function readEvent(
  orgId: string,
  endpointId: string,
  eventId: string,
  r: EventReaders,
): Promise<EventResult> {
  try {
    const event = await r.getEvent(orgId, eventId);
    if (!event || event.endpointId !== endpointId) return { status: "not_found" };
    return { status: "ok", event };
  } catch (error) {
    logActionError("events.get_failed", error);
    return { status: "error" };
  }
}
