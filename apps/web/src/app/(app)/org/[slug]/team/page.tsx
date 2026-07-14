import { personalOrgId } from "@webhook-co/db/org-lifecycle";
import { canGrantRole, MEMBERSHIP_ROLES, type MembershipRole } from "@webhook-co/shared";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { TeamManager } from "@/components/team-manager";
import { createInviteAction, revokeInviteAction } from "@/server/invite-actions";
import { leaveOrgAction } from "@/server/leave-org";
import { changeMemberRoleAction, removeMemberAction } from "@/server/member-actions";
import { loadTeam } from "@/server/team";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Team · webhook.co",
};

/** Owner/admin manage members; a plain member sees the team read-only. */
function canManageMembers(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Both calls take the SAME (slug, subPath): requireOrgAccess is cache()d on its arguments, so a mismatched
  // subPath here would miss the cache and issue a second directory read for one render.
  const [result, session] = await Promise.all([
    loadTeam(slug, "/team"),
    requireOrgAccess(slug, "/team"),
  ]);
  // You cannot leave your own personal org — there'd be nowhere to go, and the account-delete flow is what
  // actually erases it. personalOrgId is derived, so this costs no query.
  const isPersonalOrg = session.orgId === personalOrgId(session.userId);
  const role: MembershipRole = result.status === "ok" ? result.role : "member";
  // The roles this caller may hand out — the same ceiling the server actions enforce. The client only ever
  // sees roles it's allowed to pick; the actions re-check regardless (the picker is UX, not the gate).
  const grantableRoles = MEMBERSHIP_ROLES.filter((r) => canGrantRole(role, r));

  return (
    <PageContainer>
      {/* The heading lives INSIDE TeamManager, next to the Invite button it shares a row with. Two components
          cannot own opposite ends of the same flex row, and the button has to be a client component (it opens
          a dialog) — so the header goes to the client, rather than the button being marooned in a card. */}
      <TeamManager
        result={result}
        grantableRoles={grantableRoles}
        canManage={canManageMembers(role)}
        createInvite={createInviteAction.bind(null, session.slug)}
        revokeInvite={revokeInviteAction.bind(null, session.slug)}
        changeRole={changeMemberRoleAction.bind(null, session.slug)}
        removeMember={removeMemberAction.bind(null, session.slug)}
        leaveOrg={leaveOrgAction.bind(null, session.slug)}
        isPersonalOrg={isPersonalOrg}
      />
    </PageContainer>
  );
}
