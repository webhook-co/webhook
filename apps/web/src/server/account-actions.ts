"use server";

import {
  deleteOrgWithAudit,
  isOrgOwner,
  lastOwnerWouldOrphan,
  personalOrgId,
  readOrgMembershipCensus,
} from "@webhook-co/db/org-lifecycle";
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

  // 1. Erase the personal org (if the user still owns it) — webhook_app side, with the audit key.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const app = await getTenantDb();
  try {
    const personalOrg = personalOrgId(session.userId);
    if (await isOrgOwner(app, session.userId, personalOrg)) {
      // Last-owner guard (2.1): refuse to erase an account that is the SOLE owner of an org with other
      // members — deleting it (and, in step 2, cascading the membership away) would orphan them: a
      // zero-owner org can never be reached, billed-out, or alerted again. The owner must transfer
      // ownership first. A solo org (just them) is safe and proceeds. Checked BEFORE the identity delete.
      //
      // SCOPE — personal org only: it's the sole org webhook_app can census from a web session (RLS +
      // personalOrgId). Today that's complete, because there is no path to add a member to any org
      // (createMembership has no prod caller; no invites), so no shared org exists to orphan. But the
      // step-2 identity delete cascades memberships GLOBALLY. So when Lane 2 makes shared orgs reachable
      // (invites / createMembership), this guard MUST expand to every org the user solely owns — a
      // role-scoped cross-org census — or a sole owner of a shared org will still orphan it here.
      const census = await readOrgMembershipCensus(app, personalOrg);
      if (lastOwnerWouldOrphan(census)) {
        throw new Error(
          "You're the only owner of an organization that has other members. Transfer ownership to " +
            "another member before deleting your account.",
        );
      }
      await deleteOrgWithAudit(
        app,
        { orgId: personalOrg, actor: userActor(session.userId) },
        auditKey,
      );
    }
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
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
