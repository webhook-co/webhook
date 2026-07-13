"use server";

import { deleteOrgWithAudit } from "@webhook-co/db/org-lifecycle";
import { sessionCookieOptions } from "./session-cookie";
import { userActor } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { requireOrgAccess } from "./org-access";
import { LOGOUT_URL, SESSION_COOKIE } from "./session";

/**
 * Permanently delete the current organization: cascade-delete all its Postgres data, PRESERVE the
 * tamper-evident WORM audit trail (the org.deleted entry closes it out), and enqueue the durable R2
 * payload-body purge. OWNER-ONLY: the web session model is otherwise flat ("any member may manage"),
 * which is not enough for an irreversible, org-wide destroy — so we gate on the role from
 * `requireOrgAccess` (which also proves current membership). A typed "DELETE" acknowledgement is
 * required (client gate + re-checked here).
 *
 * On success the org — and therefore this session's tenancy — no longer exists, so we clear the
 * cookie and return to sign-in.
 */
export async function deleteOrganization(slug: string, formData: FormData): Promise<void> {
  // No subPath: an action doesn't render. (The redirect at the end is to sign-out — the org is gone, so
  // there is no `/org/{slug}` left to send anyone to.)
  const { userId, orgId, role } = await requireOrgAccess(slug);

  // Defense-in-depth beyond the client's disabled-until-typed button: the destructive action itself
  // refuses unless the explicit acknowledgement is present.
  if (formData.get("confirm") !== "DELETE") {
    throw new Error("organization delete not confirmed");
  }

  if (role !== "owner") {
    throw new Error("only an organization owner can delete the organization");
  }

  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const app = await getTenantDb();
  try {
    await deleteOrgWithAudit(app, { orgId, actor: userActor(userId) }, auditKey);
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }

  // Same attributes as the set — a `__Host-` cookie cleared without `Secure` is rejected by the browser
  // and the session would survive (RFC 6265bis §4.1.3).
  (await cookies()).delete({ name: SESSION_COOKIE, ...sessionCookieOptions() });
  redirect(LOGOUT_URL);
}
