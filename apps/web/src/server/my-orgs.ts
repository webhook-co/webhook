import "server-only";

import { listUserOrgs, type UserOrg } from "@webhook-co/db/orgs";

import { withTenantDb } from "./db";
import { verifySession } from "./session";

// The orgs the signed-in user may switch between (Lane 2.7). Read for the shell on every gated page, so it
// stays cheap: one index-served query over the user's own memberships.
//
// It gates on verifySession rather than requireOrgAccess deliberately: this read is about the USER, not the
// current org, and it must still work when the session's org has become unreachable (e.g. they were removed
// from it) — that's precisely when someone needs the switcher to get back to an org they do belong to.

export interface MyOrgs {
  readonly orgs: readonly UserOrg[];
  readonly currentOrgId: string;
}

/** Every org the signed-in user belongs to, plus which one the session is currently acting as. */
export async function loadMyOrgs(): Promise<MyOrgs> {
  const session = await verifySession();
  try {
    const orgs = await withTenantDb((app) => listUserOrgs(app, session.userId));
    return { orgs, currentOrgId: session.orgId };
  } catch {
    // The shell must never fail to render because the switcher's read blipped. Degrade to "no choice".
    return { orgs: [], currentOrgId: session.orgId };
  }
}
