"use server";

import { logActionError } from "./action-log";
import { getConnectedAppsBinding } from "./env";
import { verifySession } from "./session";

export type RevokeConnectedAppResult = { ok: true } | { ok: false; error: string };

/**
 * Revoke one connected app (an authorized OAuth client) by its grant id. Re-verifies the session and passes
 * the SERVER-authenticated userId to auth. — the provider's revokeGrant is keyed by (grantId, userId), so a
 * user can only ever revoke their OWN grant (a mismatched id simply no-ops). Idempotent.
 */
export async function revokeConnectedApp(grantId: string): Promise<RevokeConnectedAppResult> {
  const session = await verifySession();
  if (!grantId.trim()) return { ok: false, error: "Missing app id." };
  const binding = getConnectedAppsBinding();
  if (!binding) return { ok: false, error: "Revoking apps is temporarily unavailable." };
  try {
    await binding.revoke(session.userId, grantId);
    return { ok: true };
  } catch (error) {
    logActionError("connected_apps.revoke_failed", error);
    return { ok: false, error: "We couldn't revoke access. Please try again." };
  }
}
