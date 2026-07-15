import "server-only";

// Legacy dashboard bookmarks — the pure half.
//
// The URL move (ADR-0117) put every dashboard section under `/org/{slug}/…` and DELETED the old top-level
// paths (`/endpoints`, `/billing`, …). That silently 404'd every existing bookmark, shared link, and Referer.
// This forwards a KNOWN old path to the caller's DEFAULT org, preserving the full sub-path and query. It is
// NOT the cookie-acting-org guess ADR-0117 deleted: the target is the same DEFAULT org `/` resolves (a defined
// product decision, not a guess about what some other tab meant), the org is right there in the new URL, and
// nothing is written on a GET redirect. See `(app)/[...legacy]/page.tsx` for the async shell.

/**
 * The top-level dashboard segments that existed before the URL move and now live under `/org/{slug}/`.
 *
 * MUST equal the directories under `app/(app)/org/[slug]/` — `legacy-redirect.test.ts` reads the filesystem
 * and fails if the two drift, so a newly-added section can't silently reintroduce the 404.
 */
export const MOVED_SEGMENTS: ReadonlySet<string> = new Set([
  "audit",
  "billing",
  "credentials",
  "dashboard",
  "deliveries",
  "destinations",
  "endpoints",
  "settings",
  // The read-only suspension screen (PR2b). It postdates the URL move, so no legacy `/suspended` bookmark can
  // exist — but the drift guard requires every top-level segment be listed, and forwarding a hypothetical old
  // path to the default org is harmless and consistent.
  "suspended",
  "team",
  "triggers",
  "usage",
]);

/**
 * Is this a bookmark to a moved dashboard path? Only the FIRST segment decides — `/endpoints/{id}/events/{id}`
 * keys on `endpoints`. An unknown first segment is a genuine 404 (a typo, a probe), not a stale bookmark, and
 * is left to 404 rather than redirected one level deeper.
 */
export function isLegacyDashboardPath(legacy: readonly string[] | undefined): boolean {
  return !!legacy && legacy.length > 0 && MOVED_SEGMENTS.has(legacy[0]!);
}

/** The canonical `/org/{slug}/…` URL for a legacy path, preserving the deep sub-path and the query string. */
export function buildLegacyTarget(
  slug: string,
  legacy: readonly string[],
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const path = legacy.map(encodeURIComponent).join("/");
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) for (const one of value) qs.append(key, one);
    else if (value !== undefined) qs.append(key, value);
  }
  const query = qs.toString();
  return `/org/${slug}/${path}${query ? `?${query}` : ""}`;
}
