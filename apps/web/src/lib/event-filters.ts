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

import { VERIFICATION_STATES } from "./verification-state";

/** The coerced, SQL-ready filter (instant bounds). Mirrors the db `ListEventsOptions` filter fields. */
export interface EventFilters {
  readonly provider?: string;
  readonly receivedAfter?: Date;
  readonly receivedBefore?: Date;
  readonly verificationState?: VerificationState;
}

/** The raw, human-facing filter values as they ride in the URL query + across the load-more boundary. */
export interface EventFilterParams {
  readonly provider?: string | null;
  /** A `YYYY-MM-DD` calendar day (from a date input) or a full ISO instant. */
  readonly from?: string | null;
  readonly to?: string | null;
  /** Verification tri-state (`?status=`): verified | failed | unattempted. */
  readonly status?: string | null;
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
): EventFilters {
  const filters: {
    provider?: string;
    receivedAfter?: Date;
    receivedBefore?: Date;
    verificationState?: VerificationState;
  } = {};
  const provider = cleanString(params.provider);
  if (
    provider !== undefined &&
    (validProviders === undefined || validProviders.includes(provider))
  ) {
    filters.provider = provider;
  }
  const receivedAfter = toInstant(params.from);
  if (receivedAfter !== undefined) filters.receivedAfter = receivedAfter;
  const receivedBefore = toInstant(params.to);
  if (receivedBefore !== undefined) filters.receivedBefore = receivedBefore;
  const status = cleanString(params.status);
  // Validate against the closed enum (a hand-edited `?status=foo` is dropped, not passed to SQL).
  if (status !== undefined && (VERIFICATION_STATES as readonly string[]).includes(status)) {
    filters.verificationState = status as VerificationState;
  }
  return filters;
}

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
    filters.verificationState !== undefined
  );
}
