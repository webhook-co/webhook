import { redirect } from "next/navigation";

import { loadMyOrgs } from "@/server/my-orgs";
import { LOGOUT_URL } from "@/server/session";

// dal-gate-allow: owns no tenant data. It reads only the caller's OWN org directory (user-scoped, via the
// SECURITY DEFINER `user_org_directory()`) to decide where to send them, then redirects. It cannot render an
// org's data because it has no org — that is the very question it exists to answer.

/**
 * `/` — the post-login landing, and the ONE survivor of the hard cutover.
 *
 * Every other pre-move path (`/endpoints`, `/dashboard`, …) is gone rather than redirected. A legacy
 * redirector would have to GUESS an org from the cookie, which is exactly the ambiguity the URL move deletes
 * — it would keep the bug alive as a supported route.
 *
 * `/` is different, and not as a technicality. It has no org in it because there is no org to have: the user
 * has just authenticated and has not said where they want to be. Choosing their DEFAULT org here is a defined
 * product decision, not a guess about what some other tab meant.
 *
 * The default is the session's `orgId` — which after the URL move is nothing more than a "last acting org"
 * hint, never authoritative — VALIDATED against the directory, falling back to the first org they belong to.
 * Belonging to none means the session names an org that is gone or that they have been removed from, with
 * nothing to fall back to: sign them out rather than loop.
 */
export default async function AppHome() {
  const { orgs, currentOrgId } = await loadMyOrgs();

  // The hint is untrusted FOR THIS PURPOSE: it may name an org they have since been removed from. It is only
  // ever used to PICK from the directory, never to bypass it.
  const target = orgs.find((o) => o.orgId === currentOrgId) ?? orgs[0];
  if (!target) redirect(LOGOUT_URL);

  redirect(`/org/${target.slug}/dashboard`);
}
