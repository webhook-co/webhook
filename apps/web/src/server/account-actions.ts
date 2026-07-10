"use server";

import { deleteOrgWithAudit, isOrgOwner, personalOrgId } from "@webhook-co/db/org-lifecycle";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getTenantDb } from "./db";
import { getAccountDeleterBinding, getAuditChainKey } from "./env";
import { LOGIN_URL, SESSION_COOKIE, verifySession } from "./session";

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
      await deleteOrgWithAudit(app, { orgId: personalOrg, actor: session.userId }, auditKey);
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
  (await cookies()).delete({ name: SESSION_COOKIE, path: "/" });
  redirect(LOGIN_URL);
}
