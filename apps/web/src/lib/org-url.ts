// Pure org-URL helpers, usable from BOTH server and client (no "use client" directive, no hooks).
//
// `useOrgSlug` (the hook) stays in org-path.ts because it IS client-only. These two are just string functions
// and are imported by server components (pages) too, so they must not sit behind a client boundary.

/**
 * An absolute URL inside an org: `orgHref("acme", "/endpoints/123")` → `/org/acme/endpoints/123`.
 *
 * Use this for EVERY dashboard link. A bare `/endpoints` no longer exists — the hard cutover deleted it — so
 * a link that forgets the prefix is a 404, and neither the type checker nor a unit test that only asserts
 * "there is an anchor here" will notice. `slug === ""` (a component rendered outside an org route) yields the
 * bare path, which 404s LOUDLY rather than linking into the wrong org — a broken link beats a wrong one.
 */
export function orgHref(slug: string, path: string): string {
  return slug ? `/org/${slug}${path}` : path;
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
