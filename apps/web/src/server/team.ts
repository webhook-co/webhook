import "server-only";

import { listPendingInvites, type PendingInvite } from "@webhook-co/db/invites";
import { readOrgMembershipCensus } from "@webhook-co/db/org-lifecycle";
import type { MembershipRole } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { requireOrgAccess } from "./org-access";

// The team read layer (Lane 2.5, part 2). Loads what the /team page shows: the caller's role (so the UI
// knows whether to offer invite/revoke), the member census (a summary count — the full member list is a
// later slice, 2.6/2.7), and the pending invites. Gates on requireOrgAccess, so a removed member / stale
// session is turned away at the door and the role is a single server-derived source of truth (never client
// input). Reads run under the org's RLS context; a failure returns an error result rather than throwing.

export type TeamResult =
  | {
      readonly status: "ok";
      readonly role: MembershipRole;
      readonly memberCount: number;
      readonly ownerCount: number;
      readonly invites: readonly PendingInvite[];
    }
  | { readonly status: "error" };

/** Load the current org's team view (role + census + pending invites) for the /team page. */
export async function loadTeam(): Promise<TeamResult> {
  const { orgId, role } = await requireOrgAccess();
  try {
    const [census, invites] = await withTenantDb((app) =>
      Promise.all([readOrgMembershipCensus(app, orgId), listPendingInvites(app, orgId)]),
    );
    return {
      status: "ok",
      role,
      memberCount: census.total,
      ownerCount: census.owners,
      invites,
    };
  } catch (error) {
    logActionError("team.load_failed", error);
    return { status: "error" };
  }
}
