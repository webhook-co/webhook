import { canGrantRole, MEMBERSHIP_ROLES, type MembershipRole } from "@webhook-co/shared";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { TeamManager } from "@/components/team-manager";
import { createInviteAction, revokeInviteAction } from "@/server/invite-actions";
import { changeMemberRoleAction, removeMemberAction } from "@/server/member-actions";
import { loadTeam } from "@/server/team";

export const metadata: Metadata = {
  title: "Team · webhook.co",
};

/** Owner/admin manage members; a plain member sees the team read-only. */
function canManageMembers(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export default async function TeamPage() {
  const result = await loadTeam();
  const role: MembershipRole = result.status === "ok" ? result.role : "member";
  // The roles this caller may hand out — the same ceiling the server actions enforce. The client only ever
  // sees roles it's allowed to pick; the actions re-check regardless (the picker is UX, not the gate).
  const grantableRoles = MEMBERSHIP_ROLES.filter((r) => canGrantRole(role, r));

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Team</h1>
        <p className="leading-snug text-fg-secondary">
          The people in your organization and the invites waiting to be accepted.
        </p>
      </div>
      <TeamManager
        result={result}
        grantableRoles={grantableRoles}
        canManage={canManageMembers(role)}
        createInvite={createInviteAction}
        revokeInvite={revokeInviteAction}
        changeRole={changeMemberRoleAction}
        removeMember={removeMemberAction}
      />
    </PageContainer>
  );
}
