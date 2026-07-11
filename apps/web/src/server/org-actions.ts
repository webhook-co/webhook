"use server";

import { deleteOrgWithAudit, isOrgOwner } from "@webhook-co/db/org-lifecycle";
import { userActor } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { LOGIN_URL, SESSION_COOKIE, verifySession } from "./session";

/**
 * Permanently delete the current organization: cascade-delete all its Postgres data, PRESERVE the
 * tamper-evident WORM audit trail (the org.deleted entry closes it out), and enqueue the durable R2
 * payload-body purge. OWNER-ONLY: the web session model is otherwise flat ("any member may manage"),
 * which is not enough for an irreversible, org-wide destroy — so we gate on `isOrgOwner` here, on top
 * of the session. A typed "DELETE" acknowledgement is required (client gate + re-checked here).
 *
 * On success the org — and therefore this session's tenancy — no longer exists, so we clear the
 * cookie and return to sign-in.
 */
export async function deleteOrganization(formData: FormData): Promise<void> {
  const session = await verifySession();

  // Defense-in-depth beyond the client's disabled-until-typed button: the destructive action itself
  // refuses unless the explicit acknowledgement is present.
  if (formData.get("confirm") !== "DELETE") {
    throw new Error("organization delete not confirmed");
  }

  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const app = await getTenantDb();
  try {
    if (!(await isOrgOwner(app, session.userId, session.orgId))) {
      throw new Error("only an organization owner can delete the organization");
    }
    await deleteOrgWithAudit(
      app,
      { orgId: session.orgId, actor: userActor(session.userId) },
      auditKey,
    );
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }

  (await cookies()).delete({ name: SESSION_COOKIE, path: "/" });
  redirect(LOGIN_URL);
}
