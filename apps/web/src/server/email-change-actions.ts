"use server";

import { appendAuthAuditEntry, personalOrgId, withTenant } from "@webhook-co/db";
import { formatAuditActor, userActor } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import type { CommitEmailChangeResult, StartEmailChangeResult } from "@webhook-co/contract";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getEmailChangeBinding } from "./env";
import { remintSessionForProfile } from "./session-remint";
import { verifySession } from "./session";

// The custom email-change ceremony's web surface. The `user` email lives on the global identity realm that
// only auth. (webhook_auth) may write, so this verifies the session and RPCs the EmailChanger binding with its
// OWN userId — a user can only ever change their own email. `start` sends a step-up OTP to the CURRENT address;
// `commit` verifies it, then auth. writes the email + revokes every IdP session + purges in-flight magic links
// + notifies the old address. On success we RE-MINT this browser's cookie with the new email so it's live
// immediately, and append a (best-effort, PII-free) `email_changed` audit row to the user's personal-org chain.
//
// dal-gate-allow: user-scoped — gates on verifySession; the identity write is the caller's own, over the RPC.

const UNAVAILABLE = "Email changes are temporarily unavailable. Please try again shortly.";

export async function startEmailChangeAction(formData: FormData): Promise<StartEmailChangeResult> {
  const session = await verifySession();
  const raw = formData.get("email");
  const newEmail = typeof raw === "string" ? raw.trim() : "";
  if (newEmail.length === 0)
    return { ok: false, error: "Enter a new email address.", reason: "invalid" };

  const binding = getEmailChangeBinding();
  if (!binding) return { ok: false, error: UNAVAILABLE };

  try {
    return await binding.start(session.userId, newEmail);
  } catch (error) {
    logActionError("email_change.start_rpc", error);
    return { ok: false, error: UNAVAILABLE };
  }
}

export async function commitEmailChangeAction(
  formData: FormData,
): Promise<CommitEmailChangeResult> {
  const session = await verifySession();
  const raw = formData.get("code");
  const code = typeof raw === "string" ? raw.trim() : "";
  if (code.length === 0)
    return { ok: false, error: "Enter the code we emailed you.", reason: "invalid_code" };

  const binding = getEmailChangeBinding();
  if (!binding) return { ok: false, error: UNAVAILABLE };

  let result: CommitEmailChangeResult;
  try {
    result = await binding.commit(session.userId, code);
  } catch (error) {
    logActionError("email_change.commit_rpc", error);
    return { ok: false, error: UNAVAILABLE };
  }
  if (!result.ok) return result;

  // Re-mint THIS browser's cookie with the new email so it's live app-wide immediately (the other IdP sessions
  // were revoked auth-side; other stateless dashboard cookies expire at their own deadline). A re-mint failure
  // is NOT fatal — the email already changed and will reflect on next login — so it must never turn the
  // committed change into a reported failure (same reasoning as the audit + notice below).
  try {
    await remintSessionForProfile({
      name: session.user.name,
      email: result.newEmail,
      image: session.user.image,
    });
  } catch (error) {
    logActionError("email_change.remint", error);
  }

  // Best-effort, PII-free audit to the user's personal-org hash chain: records that user X changed their email
  // at time T (no addresses in metadata). Never fail the change over the audit append.
  try {
    const orgId = personalOrgId(session.userId);
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    await withTenantDb((app) =>
      withTenant(app, orgId, (tx) =>
        appendAuthAuditEntry(tx, auditKey, {
          orgId,
          actor: formatAuditActor(userActor(session.userId)),
          eventType: "email_changed",
          targetId: session.userId,
          metadata: {},
        }),
      ),
    );
  } catch (error) {
    logActionError("email_change.audit", error);
  }

  return result;
}
