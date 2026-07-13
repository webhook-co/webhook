import "server-only";

import { listUserOrgs, type UserOrg } from "@webhook-co/db/orgs";
import { cache } from "react";

import { withTenantDb } from "./db";

// dal-gate-allow: reads the caller's OWN membership directory (bounded by current_app_user()), not tenant
// data. Callers gate; this is the read they gate WITH.

/**
 * The signed-in user's org directory — every org they belong to — read exactly ONCE per request.
 *
 * ── Why this module exists ──────────────────────────────────────────────────────────────────────────────
 *
 * Two callers need this list, and both ran it. `resolveOrgAccess` (the gate) reads it to resolve the URL's
 * slug inside the caller's own directory, and `loadMyOrgs` (the org switcher) reads it to populate the
 * picker. The gate was memoized; the switcher was not — so it re-issued the IDENTICAL `user_org_directory()`
 * query, on a SECOND Postgres connection, on EVERY page of the dashboard. Not on some pages. Every page.
 *
 * The layout even ran them together (`Promise.all([requireOrgAccess(slug), loadMyOrgs()])`), which made the
 * duplication concurrent and therefore invisible in wall-clock — it just quietly doubled the load.
 *
 * Memoizing the DIRECTORY READ ITSELF, rather than each caller, is what makes the duplicate structurally
 * impossible: there is now one function that knows how to ask this question, and React's per-request `cache()`
 * means asking it twice costs the same as asking it once. A third caller added tomorrow inherits that for
 * free, which the previous shape did not offer — it offered a second bug.
 *
 * Keyed on `userId` (not on the request) because that is genuinely what the answer depends on, and because a
 * cache key that omitted it would be a cross-user leak rather than a mere inefficiency.
 */
export const readUserOrgDirectory = cache(async (userId: string): Promise<readonly UserOrg[]> => {
  return withTenantDb((app) => listUserOrgs(app, userId));
});
