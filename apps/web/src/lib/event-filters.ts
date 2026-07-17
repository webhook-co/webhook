// Pure events-list filter parsing — shared by the events page (server component) and the load-more
// server action, and the type shape by the client filter bar. No "server-only" import here so the
// client may import the param type. The dashboard reads the db repo directly (no contract validation
// on that path), so this is the single place the URL/wire filter values are coerced + validated
// before they reach SQL: a blank value is dropped, an unparseable date is dropped, and an unknown
// provider (only reachable by hand-editing the URL — the dropdown only offers real ones) is dropped
// rather than passed through to a confusing empty result. The page + the action pass the SAME
// `validProviders`, so the first-page read and "Load older" agree on which filters are applied.
//
// Date semantics: `from`/`to` are HALF-OPEN instant bounds matching the canonical contract/CLI/db
// (`receivedAfter >=`, `receivedBefore <`). A bare `YYYY-MM-DD` resolves to that day's 00:00 UTC, so
// `?to=2026-06-02` is EXCLUSIVE of June 2 — identical to `wbhk events list --before 2026-06-02`. (To
// include June 2, set `to=2026-06-03`.) Keeping this exclusive holds the cross-surface parity that an
// inclusive-of-the-to-day shortcut would break.

import type { VerificationState } from "@webhook-co/shared";

import { isDatePreset, resolvePresetBound } from "./date-range";
import { VERIFICATION_STATES } from "./verification-state";

/** The coerced, SQL-ready filter (instant bounds). Mirrors the db `ListEventsOptions` filter fields. */
export interface EventFilters {
  /** Multi-select provider filter — OR'd. Set only when non-empty. */
  readonly provider?: readonly string[];
  readonly receivedAfter?: Date;
  readonly receivedBefore?: Date;
  /** Multi-select verification tri-state — OR'd. Set only when non-empty. */
  readonly verificationState?: readonly VerificationState[];
  readonly search?: string;
  /** Drill down to ONE endpoint (the org-wide browse). Absent = every endpoint in the org. */
  readonly endpointId?: string;
}

/** The raw, human-facing filter values as they ride in the URL query + across the load-more boundary. */
export interface EventFilterParams {
  /** Multi-select (`?provider=a&provider=b`) — a repeated param arrives as `string[]`. */
  readonly provider?: string | string[] | null;
  /** A `YYYY-MM-DD` calendar day (from a date input) or a full ISO instant. */
  readonly from?: string | null;
  readonly to?: string | null;
  /** Verification tri-state (`?status=`), multi-select: verified | failed | unattempted. */
  readonly status?: string | string[] | null;
  /** Free-text substring over provider_event_id + dedup_key (`?search=`); min 3 chars (pg_trgm's floor). */
  readonly search?: string | null;
  /** A relative date preset (`?range=`): 1h | 24h | 7d | 30d — resolves to a receivedAfter bound. */
  readonly range?: string | null;
  /** Drill down to ONE endpoint (`?endpointId=`) — org-wide browse only; the per-endpoint page ignores it. */
  readonly endpointId?: string | string[] | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a Next.js search param to a single string. A repeated param (`?name=a&name=b`) arrives as a
 * `string[]` at runtime, so take the first value (first-wins) rather than letting a `.trim()` on an
 * array throw a 500. `undefined`/empty → `undefined`.
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Coerce a Next.js search param (string | string[]) into a clean `string[]` for a multi-select filter:
 * a repeated param (`?provider=a&provider=b`) arrives as an array, a single one as a string. Trims +
 * drops empties. The order is the URL order (the multi-select preserves the vocabulary order on write).
 */
export function paramList(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((v) => v.trim()).filter((v) => v.length > 0);
}

function cleanString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A bare `YYYY-MM-DD` → that day's 00:00 UTC; a full ISO instant is honored as-is; invalid → undefined. */
function toInstant(value: string | null | undefined): Date | undefined {
  const s = cleanString(value);
  if (s === undefined) return undefined;
  const d = new Date(DATE_ONLY.test(s) ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Coerce raw URL/wire params into a validated, SQL-ready `EventFilters` (dropping blank/invalid).
 * `validProviders`, when supplied, drops an unknown provider so a hand-edited `?provider=foo` becomes
 * "no provider filter" rather than a confusing silent-empty result (both callers pass the real list).
 */
export function parseEventFilters(
  params: EventFilterParams,
  validProviders?: readonly string[],
  now: Date = new Date(),
): EventFilters {
  const filters: {
    provider?: string[];
    receivedAfter?: Date;
    receivedBefore?: Date;
    verificationState?: VerificationState[];
    search?: string;
    endpointId?: string;
  } = {};
  // Multi-select: validate each provider against the vocabulary (a hand-edited `?provider=foo` member
  // is dropped, not passed to SQL), de-dup, and only set the filter when at least one valid one remains.
  const providers = [
    ...new Set(
      paramList(params.provider).filter(
        (p) => validProviders === undefined || validProviders.includes(p),
      ),
    ),
  ];
  if (providers.length > 0) filters.provider = providers;
  // Date range: a valid relative preset (`?range=7d`) OWNS the range — it resolves to a receivedAfter
  // lower bound (`now − window`) and any custom from/to are ignored. Otherwise the explicit from/to
  // bounds apply (half-open: `receivedAfter >=`, `receivedBefore <`). A bad preset id falls through to
  // from/to, and a bad date is dropped — so a hand-edited value never reaches SQL as garbage.
  if (isDatePreset(params.range)) {
    filters.receivedAfter = resolvePresetBound(params.range, now);
  } else {
    const receivedAfter = toInstant(params.from);
    if (receivedAfter !== undefined) filters.receivedAfter = receivedAfter;
    const receivedBefore = toInstant(params.to);
    if (receivedBefore !== undefined) filters.receivedBefore = receivedBefore;
  }
  // Multi-select verification: validate each against the closed enum (a hand-edited `?status=foo`
  // member is dropped), de-dup, set only when non-empty.
  const statuses = [
    ...new Set(
      paramList(params.status).filter((s) =>
        (VERIFICATION_STATES as readonly string[]).includes(s),
      ),
    ),
  ] as VerificationState[];
  if (statuses.length > 0) filters.verificationState = statuses;
  // Match the contract's `.min(3).max(256)` exactly — the web bypasses contract validation, so this IS the
  // web's copy of that rule and the surfaces disagree the moment it drifts.
  //
  // The floor is not arbitrary: `pg_trgm` extracts ZERO trigrams from a 1-2 char pattern, so `%ab%` returns
  // every row from the GIN and rechecks all of them — no index can ever serve it. A 1-char substring search
  // is also useless on its own terms. Dropped (not run) rather than passed to SQL — but the drop is
  // REPORTABLE via searchTooShort, because a silently dropped term shows the reader an unfiltered list and
  // leaves them to infer their search never ran.
  const search = cleanString(params.search);
  if (
    search !== undefined &&
    search.length >= SEARCH_MIN_LENGTH &&
    search.length <= SEARCH_MAX_LENGTH
  )
    filters.search = search;
  // SHAPE-validated only, deliberately NOT membership-validated — a departure from the provider filter
  // above, which checks its value against a static vocabulary.
  //
  // A non-uuid is dropped because `endpoint_id = 'oops'` raises 22P02: a hand-edited URL would 500. But an
  // unknown-yet-well-formed uuid is NOT dropped, because it is indistinguishable from "an endpoint you
  // cannot see" — RLS already answers it correctly with an empty page (no oracle, matching listDeliveries),
  // and hasAppliedFilters keeps the empty copy honest ("No events match these filters", not the onboarding
  // copy). Membership-checking here would also force an endpoint query on EVERY load-more.
  const endpointId = firstParam(params.endpointId ?? undefined);
  if (endpointId !== undefined && isUuid(endpointId)) filters.endpointId = endpointId;
  return filters;
}

/** A canonical v4/v7 uuid — the only shape `endpoint_id = $1` can take without raising 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);

/**
 * True when at least one filter is actually APPLIED to the query. Takes the parsed `EventFilters` (not
 * the raw params) so the filtered-empty copy stays honest: a hand-edited `?from=oops` is dropped by
 * the parser → no filter applied → the onboarding copy shows, not "no events match these filters".
 */
export function hasAppliedFilters(filters: EventFilters): boolean {
  return (
    filters.provider !== undefined ||
    filters.receivedAfter !== undefined ||
    filters.receivedBefore !== undefined ||
    filters.verificationState !== undefined ||
    filters.search !== undefined ||
    filters.endpointId !== undefined
  );
}

/** Mirrors the contract's `.trim().min(3).max(256)`. Web bypasses contract validation, so it re-states it. */
export const SEARCH_MIN_LENGTH = 3;
export const SEARCH_MAX_LENGTH = 256;

/**
 * True when a search term was typed but is too short to run (1-2 chars after trimming).
 *
 * The floor itself is unavoidable — pg_trgm extracts no trigrams below 3 characters, so no index can serve
 * `%ab%` and it degrades to scanning + rechecking every row in the org. What IS avoidable is dropping the
 * term in silence: that renders the FULL, unfiltered list in response to a search, which reads as "no filter
 * exists" rather than "your term is too short", and it flips hasAppliedFilters to false so the page can show
 * onboarding copy at someone who was searching. API/CLI/MCP 400 on the same term; web should not pretend it
 * ran. Whitespace-only is "no search", not "too short" — never nag someone who typed a space.
 */
export function searchTooShort(params: { search?: string | null }): boolean {
  const search = cleanString(params.search);
  return search !== undefined && search.length > 0 && search.length < SEARCH_MIN_LENGTH;
}
