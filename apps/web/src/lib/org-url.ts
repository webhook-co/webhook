// Pure org-URL helpers, usable from BOTH server and client (no "use client" directive, no hooks).
//
// `useOrgSlug` (the hook) stays in org-path.ts because it IS client-only. These two are just string functions
// and are imported by server components (pages) too, so they must not sit behind a client boundary.

/**
 * An absolute URL inside an org: `orgHref("acme", "/endpoints/123")` → `/org/acme/endpoints/123`.
 *
 * Use this for EVERY dashboard link. A bare `/endpoints` no longer exists — the hard cutover deleted it — so
 * a link that forgets the prefix is a 404, and neither the type checker nor a unit test that only asserts
 * "there is an anchor here" will notice.
 *
 * `slug === ""` (a component rendered outside an org route) must still never link into a DIFFERENT org — a
 * broken link beats a wrong one. Returning the BARE path did not honour that, and the comment here used to
 * claim it did: `(app)/[...legacy]` claims any path whose first segment is in `MOVED_SEGMENTS` and 307s the
 * reader into their DEFAULT org rather than 404ing.
 *
 * The fallback therefore routes through a slug that CANNOT EXIST, rather than through one that merely
 * happens to be unregistered today. `-` fails `validateOrgSlug` on length (min 3) and on format (a slug must
 * start and end alphanumeric), so no org can ever hold it and `resolveOrgAccess` can only `notFound()`.
 * Leaning on the reserved-slug list instead would have been one drift away from breaking: `MOVED_SEGMENTS`
 * contains `suspended`, which is NOT in `ORG_SLUG_RESERVED` — `/org/suspended/…` reaches a real org for
 * anyone who registers that slug. Pinned by org-url.test.ts against both real sets.
 */
export function orgHref(slug: string, path: string): string {
  return slug ? `/org/${slug}${path}` : `/org/-${path}`;
}

/**
 * Serialise a Next `searchParams` object back into a `?a=b&c=d` string (empty when there are none).
 *
 * Carries a page's query INTO `requireOrgAccess`'s subPath, so the canonicalizing 308 for a mis-cased or
 * renamed slug preserves the reader's filters and cursor. A bare-path redirect would silently drop them — and
 * a shared, filtered, paginated link is exactly the "old links keep working" case the former-slug history
 * exists to protect. `URLSearchParams` handles repeated (multi-select) params and encoding.
 */
export function queryString(sp: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) for (const one of v) params.append(k, one);
    else if (v !== undefined) params.append(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}
