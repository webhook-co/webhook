import "server-only";

import { listUserOrgs, type UserOrg } from "@webhook-co/db/orgs";

import { withTenantDb } from "./db";
import { verifySession } from "./session";

// The orgs the signed-in user may switch between (Lane 2.7). Read for the shell on every gated page, so it
// stays cheap: one index-served query over the user's own memberships.
//
// It gates on verifySession rather than requireOrgAccess deliberately, and that is NOT an oversight of the
// kind ADR-0116 fixed: this read is scoped to the USER, not to an org. `listUserOrgs` answers "which orgs is
// this user in?" from the user's own memberships (the SECURITY DEFINER directory, ADR-0113); it is not a
// tenant read and there is no org to prove membership of. Gating it on requireOrgAccess would be circular.
//
// Note what this does NOT do any more. It used to be justified as the escape hatch for a removed member —
// "the switcher is how they get back to an org they do belong to". Since ADR-0116 the (app) layout itself
// calls requireOrgAccess, so a session naming an org the user has left never renders the shell at all: they
// are redirected to auth., which re-mints a session for an org they ARE in. That is the recovery path now.
// The switcher is for choosing among orgs you can already act in, not for digging out of one you cannot.

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
