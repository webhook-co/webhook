"use server";

import { LastOwnerError, removeMember } from "@webhook-co/db/members";
import { listUserOrgs } from "@webhook-co/db/orgs";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { redirect } from "next/navigation";

import { logActionError } from "./action-log";
import { evictRevokedKeyHashes } from "./credential-revoke";
import { withTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { LOGOUT_URL } from "./session";
import { requireOrgAccess } from "./org-access";
import { remintSessionForOrg } from "./session-remint";

// Leave an organization (Lane 2.9).
//
// This closes a dead end the rest of the lane created: member removal is owner/admin-only AND refuses to act
// on your own row, so an invited teammate had NO WAY OUT of a team. They could be removed, but never leave.
//
// Leaving is just removing yourself, so it reuses the SAME atomic revocation as removeMember — the membership
// row and every credential it authorized die in one transaction — rather than a parallel code path that
// could drift from it. The last-owner guard applies unchanged: a sole owner cannot leave, because that would
// strand the org with no owner. They must promote someone else to owner first (which the /team role picker
// allows), or delete the org outright.
//
// Afterwards the session still names an org the user is no longer in, so it is re-minted onto another org
// they belong to — otherwise requireOrgAccess would bounce them to sign-in on the very next request, which
// looks exactly like being logged out.

export type LeaveOrgResult = { readonly status: "last_owner" } | { readonly status: "error" };

/**
 * Leave the current org. Redirects on success (so it never returns); returns a result only on refusal, which
 * the page renders. A sole owner is refused — nothing is revoked and nothing is deleted.
 */
export async function leaveOrgAction(): Promise<LeaveOrgResult> {
  const { orgId, userId, role, user } = await requireOrgAccess();

  let removed: Awaited<ReturnType<typeof removeMember>>;
  try {
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    removed = await withTenantDb((app) =>
      removeMember(app, {
        orgId,
        userId, // self
        actorId: userId,
        actorRole: role,
        auditKey,
      }),
    );
  } catch (error) {
    if (error instanceof LastOwnerError) return { status: "last_owner" };
    logActionError("org.leave_failed", error);
    return { status: "error" };
  }

  // Committed. Kill the cached credentials (the DB revoke is durable; this closes the cache TTL window).
  await evictRevokedKeyHashes(removed.revokedKeyHashes, { kind: "member", id: userId });

  // The session names an org we've just left. Move it to another org they belong to. Everyone keeps their
  // personal org, so there is normally one; if somehow not, sign them out rather than leave a session
  // pointing at an org they can no longer access.
  const remaining = await withTenantDb((app) => listUserOrgs(app, userId));
  const next = remaining.find((o) => o.orgId !== orgId);
  if (!next) redirect(LOGOUT_URL);

  if ((await remintSessionForOrg({ userId, user }, next.orgId)) !== "ok") {
    redirect(LOGOUT_URL); // couldn't re-mint (no/expired cookie) — treat as signed out, never guess
  }

  redirect("/dashboard?org=left");
}
