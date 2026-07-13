"use server";

import { classifyOwnedOrgs, deleteOrgWithAudit } from "@webhook-co/db/org-lifecycle";
import { sessionCookieOptions } from "./session-cookie";
import { userActor } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getTenantDb } from "./db";
import { getAccountDeleterBinding, getAuditChainKey } from "./env";
import { LOGOUT_URL, SESSION_COOKIE, verifySession } from "./session";

/**
 * Permanently erase the signed-in user's account (right to erasure, slice 2.2):
 *  1. delete the org(s) they SOLELY own — their personal org — via slice 2.1's deleteOrgWithAudit
 *     (cascade + WORM-audit preservation + durable R2 purge), as webhook_app;
 *  2. delete the identity itself via auth.'s AccountDeleter RPC (only webhook_auth may touch
 *     user/session/account) — cascades remaining sessions/accounts/memberships;
 *  3. clear the session cookie and return to sign-in.
 *
 * SELF-service: always targets the verified session's OWN userId. A typed "DELETE" acknowledgement is
 * required (client gate + re-checked here).
 *
 * v1 scope: multi-org ownership isn't a shipped feature (every user has one bootstrap personal org,
 * and RLS blocks a cross-org "orgs you own" query for webhook_app), so only the personal org is
 * handled here. If the user already deleted their personal org, `isOrgOwner` is false and we skip to
 * step 2.
 */
export async function deleteAccount(formData: FormData): Promise<void> {
  const session = await verifySession();

  if (formData.get("confirm") !== "DELETE") {
    throw new Error("account erasure not confirmed");
  }

  // 1. Erase every org the user SOLELY owns — and REFUSE outright if any of them has other members.
  //
  // This used to census only their PERSONAL org, which was complete only while no shared org could exist.
  // Invites changed that, and the gap is reachable in production: an owner may invite ANOTHER OWNER, who
  // accepts and then finds themselves the sole owner once the original owner steps down. That org is not
  // their personal org — so the old guard never looked at it, while step 2's identity delete cascades their
  // membership away GLOBALLY, leaving it with ZERO owners: unreachable by RLS forever, still billed, and its
  // failure alerts going nowhere.
  //
  // classifyOwnedOrgs (2.1b) censuses EVERY org they own, which only became answerable once 2.4a's
  // user_org_directory made "which orgs am I in?" a question the tenant role can ask at all.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  // The REQUEST owns the client now (see server/db.ts): it is shared by every loader in this render and
  // closed once, after the response. Closing it here would pull the connection out from under the others.
  const app = await getTenantDb();
  const { wouldOrphan, soleOwnedSolo } = await classifyOwnedOrgs(app, session.userId);

  if (wouldOrphan.length > 0) {
    // Name them: "transfer ownership" is only actionable if the user knows WHICH org to transfer.
    const names = wouldOrphan.map((o) => o.name).join(", ");
    throw new Error(
      `You're the only owner of an organization that has other members (${names}). Transfer ` +
        "ownership to another member before deleting your account.",
    );
  }

  // Solo-owned orgs (nobody else in them) are erased WITH the account. Leaving them behind would be an
  // even more complete orphan than the one above: no owner, no members, nobody to notice — and still
  // billed.
  for (const org of soleOwnedSolo) {
    await deleteOrgWithAudit(app, { orgId: org.orgId, actor: userActor(session.userId) }, auditKey);
  }

  // 2. Erase the identity — only auth. (webhook_auth) can, so RPC its AccountDeleter entrypoint.
  const deleter = getAccountDeleterBinding();
  if (!deleter) {
    throw new Error("account erasure is temporarily unavailable");
  }
  await deleter.deleteAccount(session.userId);

  // 3. The account (and this session's tenancy) no longer exists — clear the cookie, return to login.
  // Same attributes as the set — a `__Host-` cookie cleared without `Secure` is rejected by the browser
  // and the session would survive (RFC 6265bis §4.1.3).
  (await cookies()).delete({ name: SESSION_COOKIE, ...sessionCookieOptions() });
  redirect(LOGOUT_URL);
}
