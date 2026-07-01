// Pure deliveries-list filter parsing — shared by the deliveries page (server component) and the
// load-more server action, and the param type by the client filter bar. No "server-only" import here
// (the type-only `DeliveryFilters` import is fully erased) so the client may import the param type. The
// dashboard reads the db repo directly (no contract validation on that path), so this is the single
// place the URL/wire filter values are coerced + validated before they reach SQL: a blank value is
// dropped and an unknown status (only reachable by hand-editing the URL — the dropdown only offers real
// ones) is dropped rather than passed through to a confusing empty result. The page + the action pass
// the SAME raw params through `parseDeliveryFilters`, so the first-page read and "Load older" agree on
// which filters are applied.

import { DELIVERY_STATUSES, type DeliveryStatus } from "@webhook-co/shared";

import type { DeliveryFilters } from "@/server/deliveries";

/** The raw, human-facing filter values as they ride in the URL query + across the load-more boundary. */
export interface DeliveryFilterParams {
  /** Multi-select (`?status=a&status=b`) — a repeated param arrives as `string[]`, a single one as a string. */
  readonly status?: string | string[] | null;
}

/**
 * Coerce a Next.js search param (string | string[]) into a clean `string[]` for a multi-select filter:
 * a repeated param arrives as an array, a single one as a string. Trims + drops empties. The order is
 * the URL order (the multi-select preserves the vocabulary order on write).
 */
function paramList(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Coerce raw URL/wire params into a validated `DeliveryFilters` (dropping blank/unknown). The status
 * multi-select is validated against the closed `DELIVERY_STATUSES` vocabulary — a hand-edited
 * `?status=foo` member is dropped, not passed to SQL — de-duped, and the filter is set only when at
 * least one valid status remains.
 */
export function parseDeliveryFilters(params: DeliveryFilterParams): DeliveryFilters {
  const filters: { status?: DeliveryStatus[] } = {};
  const statuses = [
    ...new Set(
      paramList(params.status).filter((s) => (DELIVERY_STATUSES as readonly string[]).includes(s)),
    ),
  ] as DeliveryStatus[];
  if (statuses.length > 0) filters.status = statuses;
  return filters;
}

/**
 * True when at least one filter is actually APPLIED to the query. Takes the parsed `DeliveryFilters`
 * (not the raw params) so the filtered-empty copy stays honest: a hand-edited `?status=oops` is dropped
 * by the parser → no filter applied → the onboarding copy shows, not "no deliveries match this filter".
 */
export function hasAppliedDeliveryFilters(filters: DeliveryFilters): boolean {
  return (
    filters.status !== undefined ||
    filters.destinationId !== undefined ||
    filters.subscriptionId !== undefined
  );
}
