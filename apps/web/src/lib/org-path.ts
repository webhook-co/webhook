"use client";

import { useParams } from "next/navigation";

export { orgHref } from "./org-url";

/**
 * The org slug of the route the component is rendered in.
 *
 * Every dashboard route lives under `/org/{slug}/…`, so a client component inside the shell can simply read
 * the segment rather than have it threaded down as a prop through however many layers sit between it and the
 * page. `useParams()` is the escape hatch: the slug is part of the URL, and the URL is the source of truth for
 * which org we are in. Returns "" outside an org route (rendered under `/`, or a unit test with no router).
 */
export function useOrgSlug(): string {
  const params = useParams<{ slug?: string }>();
  return typeof params?.slug === "string" ? params.slug : "";
}
