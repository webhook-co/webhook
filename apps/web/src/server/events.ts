import "server-only";

import { withTenant, type Sql, type TenantTx } from "@webhook-co/db/client";
import {
  getEndpoint,
  getEvent,
  listEndpointNames,
  listEvents,
  listOrgEvents,
  type EndpointNameEntry,
} from "@webhook-co/db/reads";
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
  { readonly ok: true; readonly value: string } | { readonly ok: false };

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
  /**
   * `reason` mirrors {@link OrgEventsResult} so the per-endpoint page can advise something the reader can ACT
   * on. This page browses ALL-TIME (no 7d default, unlike the org-wide page), so an unindexed residual — the
   * headerSearch scan (#24) over `headers::text` — can DETERMINISTICALLY blow the 5s browse statement_timeout
   * (Postgres 57014). "Refresh to try again" then cannot work (the query is deterministic); narrowing the date
   * range is the only thing that helps. `unknown` keeps the generic message for a real blip, where refreshing
   * IS the right advice.
   */
  | { readonly status: "error"; readonly reason: "timeout" | "unknown" };

/**
 * The ORG-WIDE events browse result.
 *
 * No `not_found` arm, deliberately: `EventsResult` has one because an endpoint-scoped read must distinguish
 * "no events" from "no such endpoint". Org-wide there is no endpoint to be absent — an org with no events is
 * `ok` with an empty list. The arm would be unreachable, and an unreachable arm is a lie the type tells.
 */
export type OrgEventsResult =
  | {
      readonly status: "ok";
      readonly items: readonly EventSummaryItem[];
      readonly nextCursor: Cursor | null;
      /** Endpoint id → name + deleted, for labelling rows. INCLUDES soft-deleted endpoints (ADR-0076). */
      readonly endpointNames: Readonly<Record<string, EndpointNameEntry>>;
    }
  /**
   * `reason` exists so the page can say something the reader can ACT on.
   *
   * A browse that blows the 5s statement_timeout will blow it again on refresh — the query is deterministic —
   * so "Refresh to try again" is advice that cannot work. The only thing that helps is narrowing the window,
   * and the reader cannot know that unless we say it. `unknown` keeps the honest generic message for a real
   * blip, where refreshing IS the right advice.
   */
  | { readonly status: "error"; readonly reason: "timeout" | "unknown" };

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
  /** First page of the ORG's events (filtered) + the endpoint-name map, in ONE tenant tx. */
  orgFirstPage(
    orgId: string,
    filters?: EventFilters,
  ): Promise<{ page: EventsPage; endpointNames: Readonly<Record<string, EndpointNameEntry>> }>;
  /** A subsequent page of the org's events. The name map is already on the client. */
  listOrgEvents(orgId: string, cursor: Cursor, filters?: EventFilters): Promise<EventsPage>;
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
        // endpointId AFTER the spread: this page is scoped by its PATH, and a client-supplied
        // filters.endpointId must never override it. `filters` is re-parsed from client input in
        // loadMoreEventsAction, and EventFilters gained an endpointId for the org-wide browse — so with the
        // old `{ endpointId, ...filters }` order a caller could append endpoint B's events into endpoint A's
        // list (rows that then 404, since loadEvent scopes the detail read to A). RLS still bounds it to the
        // caller's own org, so this is a correctness break, not a tenant one.
        const page = await listEvents(tx, { ...filters, endpointId });
        return {
          meta,
          page: { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor },
        };
      }),
    listEvents: (orgId, endpointId, cursor, filters) =>
      withTenant(app, orgId, async (tx) => {
        // endpointId AFTER the spread — see firstPage above.
        const page = await listEvents(tx, { ...filters, cursor, endpointId });
        return { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor };
      }),
    getEvent: (orgId, eventId) =>
      withTenant(app, orgId, async (tx) => {
        const e = await getEvent(tx, eventId);
        return e ? toDetailItem(e) : null;
      }),
    orgFirstPage: (orgId, filters) =>
      withTenant(app, orgId, async (tx) => {
        // ONE tenant tx for both, so the rows and the labels can't come from different snapshots. The name
        // map is bounded by the 100-endpoint-per-org cap, so this is one small round trip — not an N+1, and
        // not a join (which would make `id` ambiguous in the events browse).
        const [page, endpointNames] = await Promise.all([
          listOrgEvents(tx, { ...filters }),
          listEndpointNames(tx),
        ]);
        return {
          page: { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor },
          endpointNames,
        };
      }),
    listOrgEvents: (orgId, cursor, filters) =>
      withTenant(app, orgId, async (tx) => {
        const page = await listOrgEvents(tx, { cursor, ...filters });
        return { items: page.items.map(toSummaryItem), nextCursor: page.nextCursor };
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
/**
 * First page of the ORG's events + the labels for them (the consolidated /org/{slug}/events page).
 *
 * No endpointId, so no uuid guard and no not_found: RLS is the whole boundary, and an org with no events is
 * an `ok` empty list.
 */
/**
 * Postgres cancels a statement that exceeds `statement_timeout` with SQLSTATE 57014 (query_canceled) — the
 * bound browseEvents sets on every events browse. Distinguishing it is what lets the page give advice that
 * can actually work; everything else is a genuine fault where "refresh" is right.
 */
function browseErrorReason(error: unknown): "timeout" | "unknown" {
  return typeof error === "object" && error !== null && "code" in error && error.code === "57014"
    ? "timeout"
    : "unknown";
}

export async function loadOrgEvents(
  orgId: string,
  filters?: EventFilters,
  readers?: EventReaders,
): Promise<OrgEventsResult> {
  if (readers) return readOrgEvents(orgId, filters, readers);
  return withTenantDb((app) => readOrgEvents(orgId, filters, boundReaders(app)));
}

async function readOrgEvents(
  orgId: string,
  filters: EventFilters | undefined,
  r: EventReaders,
): Promise<OrgEventsResult> {
  try {
    const { page, endpointNames } = await r.orgFirstPage(orgId, filters);
    return { status: "ok", items: page.items, nextCursor: page.nextCursor, endpointNames };
  } catch (error) {
    logActionError("events.org_list_failed", error);
    return { status: "error", reason: browseErrorReason(error) };
  }
}

/** A subsequent page of the org's events (the "Load older" path). */
export async function loadMoreOrgEvents(
  orgId: string,
  cursor: Cursor,
  filters?: EventFilters,
  readers?: EventReaders,
): Promise<EventsPage | null> {
  const run = (r: EventReaders) => r.listOrgEvents(orgId, cursor, filters);
  try {
    if (readers) return await run(readers);
    return await withTenantDb((app) => run(boundReaders(app)));
  } catch (error) {
    logActionError("events.org_list_more_failed", error);
    return null;
  }
}

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
    // Preserve the 57014/timeout signal exactly as readOrgEvents does — the per-endpoint page browses all-time,
    // so a deterministic timeout here needs the actionable "narrow the range" banner, not a useless "refresh".
    return { status: "error", reason: browseErrorReason(error) };
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
  rawEndpointId: string,
  rawEventId: string,
  readers?: EventReaders,
): Promise<EventResult> {
  if (!isUuid(rawEndpointId) || !isUuid(rawEventId)) return { status: "not_found" };
  // CANONICALIZE BEFORE COMPARING. `isUuid` is case-INsensitive and Postgres parses a uuid literal the same
  // way, but the endpoint check below is a JS `!==` on two strings — so an uppercase-hex `[id]` segment
  // passes the shape gate, reaches a row whose stored `endpoint_id` is canonical lowercase, and 404s an
  // event the caller owns and the list just linked them to. That is the same false-404 the destinations
  // detail page normalizes away (destinations/[id]/page.tsx); the two surfaces must not disagree about the
  // same URL. Canonicalizing does NOT widen scope: a different endpoint still fails the comparison.
  const endpointId = rawEndpointId.toLowerCase();
  const eventId = rawEventId.toLowerCase();
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
