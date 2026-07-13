import { notFound, redirect } from "next/navigation";

import { buildLegacyTarget, isLegacyDashboardPath } from "@/server/legacy-redirect";
import { loadMyOrgs } from "@/server/my-orgs";
import { LOGOUT_URL } from "@/server/session";

// dal-gate-allow: owns no tenant data. Like `/`, it reads only the caller's OWN org directory (user-scoped,
// via loadMyOrgs) to pick a default org, then redirects. It renders nothing and touches no org's data.

/**
 * Legacy dashboard bookmarks — the async shell.
 *
 * A catch-all UNDER `(app)` but OUTSIDE `org/[slug]`, so it only ever matches a path that no real route claims
 * (the static `org` segment and the `/` index both beat it). The URL move (ADR-0117) deleted the old
 * top-level paths; this forwards a KNOWN one to the caller's DEFAULT org — the same resolution `/` performs —
 * preserving the deep sub-path and query. An UNKNOWN first segment is a genuine 404 and is left as one.
 *
 * `redirect()` issues a 307 (temporary), NOT a 308: the destination is the caller's DEFAULT org and so is
 * user- and session-dependent — a permanent, cacheable redirect would pin one user's org onto the path.
 */
export default async function LegacyDashboardRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ legacy: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ legacy }, sp] = await Promise.all([params, searchParams]);

  if (!isLegacyDashboardPath(legacy)) notFound();

  const { orgs, currentOrgId } = await loadMyOrgs();
  // The "current org" is only a hint here (as at `/`): used to PICK from the directory, never to bypass it.
  const target = orgs.find((o) => o.orgId === currentOrgId) ?? orgs[0];
  if (!target) redirect(LOGOUT_URL);

  redirect(buildLegacyTarget(target.slug, legacy, sp));
}
