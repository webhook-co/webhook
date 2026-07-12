import "server-only";

import { listPendingInvites, type PendingInvite } from "@webhook-co/db/invites";
import { listOrgMembers, type OrgMember } from "@webhook-co/db/members";
import type { MembershipRole } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { requireOrgAccess } from "./org-access";

// The team read layer (Lane 2.5/2.6). Loads what the /team page shows: the caller's role and id (so the UI
// knows which rows it may act on, and which one is "you"), the org's members, and the pending invites. Gates
// on requireOrgAccess, so a removed member / stale session is turned away at the door and the role is a
// single server-derived source of truth (never client input).
//
// Member identity (name/email) comes from org_member_directory() — a SECURITY DEFINER function that hard-
// codes the org scope, because `"user"` is Better Auth's global, un-RLS'd table (migration 0066). The web
// role cannot read it any other way.

export type TeamResult =
  | {
      readonly status: "ok";
      /** The caller's role — the ceiling for every control the UI offers. */
      readonly role: MembershipRole;
      /** The caller's own user id, so the UI can mark (and not act on) their own row. */
      readonly userId: string;
      readonly members: readonly OrgMember[];
      readonly invites: readonly PendingInvite[];
    }
  | { readonly status: "error" };

/** Load the current org's team view (role + members + pending invites) for the /team page. */
export async function loadTeam(): Promise<TeamResult> {
  const { orgId, userId, role } = await requireOrgAccess();
  try {
    const [members, invites] = await withTenantDb((app) =>
      Promise.all([listOrgMembers(app, orgId), listPendingInvites(app, orgId)]),
    );
    return { status: "ok", role, userId, members, invites };
  } catch (error) {
    logActionError("team.load_failed", error);
    return { status: "error" };
  }
}
