"use client";

import { useParams } from "next/navigation";

/**
 * The org slug of the route the component is rendered in.
 *
 * Every dashboard route lives under `/org/{slug}/…`, so a client component inside the shell can simply read
 * the segment rather than have it threaded down as a prop through however many layers happen to be between it
 * and the page. `useParams()` is exactly the escape hatch for this: the slug is part of the URL, and the URL
 * is the source of truth for which org we are in.
 *
 * It returns "" outside an org route (a component rendered under `/` or in a unit test with no router). That
 * is deliberate: `orgHref("", "/endpoints")` yields `/endpoints`, which 404s LOUDLY rather than silently
 * linking into some other org. A wrong-org link is far worse than a broken one.
 */
export function useOrgSlug(): string {
  const params = useParams<{ slug?: string }>();
  return typeof params?.slug === "string" ? params.slug : "";
}

/**
 * An absolute URL inside an org: `orgHref("acme", "/endpoints/123")` → `/org/acme/endpoints/123`.
 *
 * Use this for EVERY dashboard link. A bare `/endpoints` no longer exists — the hard cutover deleted it — so
 * a link that forgets the prefix is a 404, and neither the type checker nor a unit test that only asserts
 * "there is an anchor here" will notice. That is precisely how the eight links this helper exists to fix
 * survived the route move.
 */
export function orgHref(slug: string, path: string): string {
  return slug ? `/org/${slug}${path}` : path;
}
