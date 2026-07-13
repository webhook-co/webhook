"use server";

import { createCredentialHasherFromBase64 } from "@webhook-co/db/credential";
import { acceptInvite, createInvite, revokeInvite } from "@webhook-co/db/invites";
import { listUserOrgs } from "@webhook-co/db/orgs";
import { canGrantRole, MembershipRoleSchema } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { redirect } from "next/navigation";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAppBaseUrl, getAuditChainKey, getCredentialPepper, getResendApiKey } from "./env";
import { sendInviteEmail } from "./invite-email";
import { requireOrgAccess } from "./org-access";
import { LOGOUT_URL, verifySession } from "./session";

// Invite server actions (Lane 2.5). createInvite/revoke gate on requireOrgAccess (owner/admin only) and
// pass the SERVER-derived role as the ceiling — the client can't lift it. accept gates on verifySession
// only (the accepting user is joining, not yet a member) and matches against the session's own email.
//
// The invite token is a BEARER secret. It goes to exactly two places: the invitee's inbox (emailed) and the
// inviter's screen (to share when mail is unavailable). It is never listed, logged, or re-shown.

/** Only owner/admin manage members; a plain member is operational-only. */
function canManageMembers(role: string): boolean {
  return role === "owner" || role === "admin";
}

/** The credential hasher (for the token) + the audit-chain HMAC key — both keyed by shared secrets. */
async function inviteCrypto(): Promise<{
  hasher: ReturnType<typeof createCredentialHasherFromBase64>;
  auditKey: CryptoKey;
}> {
  const [pepper, auditB64] = await Promise.all([getCredentialPepper(), getAuditChainKey()]);
  return {
    hasher: createCredentialHasherFromBase64(pepper),
    auditKey: await importAuditKey(b64ToBytes(auditB64)),
  };
}

/** A light email shape check — the DB also enforces non-empty; the verified-email match is the real gate. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CreateInviteResult =
  | {
      readonly status: "ok";
      readonly acceptPath: string;
      readonly invitedEmail: string;
      readonly role: string;
      /**
       * Did we actually email the link? False when mail isn't configured OR the send failed — the invite
       * still EXISTS either way, so the UI falls back to "copy this link and send it yourself". Never claim
       * we sent an email we didn't.
       */
      readonly emailed: boolean;
    }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "error" };

/** The verified sender for invite mail (mirrors auth.'s login@mail.webhook.co). */
const INVITE_FROM = "invites@mail.webhook.co";

/**
 * Email the invite link — BEST EFFORT. The invite is already committed by the time we get here, and the
 * inviter still holds the copy-link, so a mail outage must degrade the flow, not lose the invite. Returns
 * whether it actually sent. Failures are logged (scrubbed) and swallowed.
 */
async function tryEmailInvite(input: {
  to: string;
  acceptPath: string;
  invitedBy: string;
}): Promise<boolean> {
  try {
    const apiKey = await getResendApiKey();
    if (!apiKey) return false; // mail not configured (dev, or the binding isn't provisioned yet)
    await sendInviteEmail(
      { apiKey, from: INVITE_FROM },
      {
        to: input.to,
        url: `${getAppBaseUrl()}${input.acceptPath}`,
        invitedBy: input.invitedBy,
      },
    );
    return true;
  } catch (error) {
    logActionError("invite.email_failed", error);
    return false;
  }
}

/** Create a pending invite for the current org. Owner/admin only; the invited role can't exceed the
 *  inviter's (server-derived). Returns the accept link for the inviter to share. */
export async function createInviteAction(
  slug: string,
  formData: FormData,
): Promise<CreateInviteResult> {
  // No subPath: an action doesn't render, so there is nothing to redirect — a form posted seconds before a
  // rename still resolves straight through to the right org.
  const { orgId, userId, role, user } = await requireOrgAccess(slug);
  if (!canManageMembers(role)) return { status: "forbidden" };

  const email = String(formData.get("email") ?? "").trim();
  const roleParse = MembershipRoleSchema.safeParse(formData.get("role"));
  if (!EMAIL_RE.test(email) || !roleParse.success) {
    return { status: "invalid", message: "Enter a valid email and a role." };
  }
  const targetRole = roleParse.data;
  if (!canGrantRole(role, targetRole)) return { status: "forbidden" }; // can't invite above yourself

  try {
    const { hasher, auditKey } = await inviteCrypto();
    const invite = await withTenantDb((app) =>
      createInvite(app, hasher, {
        orgId,
        invitedEmail: email,
        role: targetRole,
        invitedBy: userId,
        inviterRole: role,
        auditKey,
      }),
    );
    // The token goes ONLY to the invitee (by email) and to its creator (to share). Never into a listing.
    const acceptPath = `/invite/accept?org=${orgId}&token=${encodeURIComponent(invite.token)}`;
    const emailed = await tryEmailInvite({
      to: invite.invitedEmail,
      acceptPath,
      invitedBy: user.email, // the inviter's own authenticated email — named so the invitee can recognise them
    });
    return {
      status: "ok",
      acceptPath,
      invitedEmail: invite.invitedEmail,
      role: invite.role,
      emailed,
    };
  } catch (error) {
    logActionError("invite.create_failed", error);
    return { status: "error" };
  }
}

export type RevokeInviteResult = { readonly status: "ok" | "forbidden" | "error" };

/** Revoke a pending invite in the current org. Owner/admin only. */
export async function revokeInviteAction(
  slug: string,
  formData: FormData,
): Promise<RevokeInviteResult> {
  const { orgId, userId, role } = await requireOrgAccess(slug);
  if (!canManageMembers(role)) return { status: "forbidden" };
  const inviteId = String(formData.get("inviteId") ?? "");
  if (!inviteId) return { status: "error" };

  try {
    const { auditKey } = await inviteCrypto();
    await withTenantDb((app) =>
      revokeInvite(app, { orgId, inviteId, revokedBy: userId, auditKey }),
    );
    return { status: "ok" };
  } catch (error) {
    logActionError("invite.revoke_failed", error);
    return { status: "error" };
  }
}

/**
 * Accept an invite from its link (`?org=&token=`). Requires only a session — the accepting user is JOINING,
 * not yet a member — and matches the invite against the SESSION's own email (never client-supplied). On any
 * outcome it lands back on a dashboard with an `?invite=` status; the redirect is issued OUTSIDE the try so
 * it isn't swallowed as an error.
 *
 * It takes NO slug: the accepting user is not yet in the org, so there is no `/org/{slug}` they could have
 * come from — the invite link carries the orgId. Now that dashboards are org-scoped the landing URL has to be
 * BUILT: we re-read the caller's own directory (which, on `accepted`, now contains the org they just joined)
 * to turn the orgId into its canonical slug. On a refusal the org isn't in the directory, so we fall back to
 * their default org — the status banner is the point, and it must still be shown somewhere they can reach.
 */
export async function acceptInviteAction(formData: FormData): Promise<void> {
  const session = await verifySession();
  const orgId = String(formData.get("org") ?? "");
  const token = String(formData.get("token") ?? "");

  let outcome: "accepted" | "invalid" | "error" = "invalid";
  if (orgId && token) {
    try {
      const { hasher, auditKey } = await inviteCrypto();
      const res = await withTenantDb((app) =>
        acceptInvite(app, hasher, {
          orgId,
          token,
          userId: session.userId,
          userEmail: session.user.email, // the session's own (authenticated) email, not client input
          auditKey,
        }),
      );
      outcome = res.status === "accepted" ? "accepted" : "invalid";
    } catch (error) {
      logActionError("invite.accept_failed", error);
      outcome = "error";
    }
  }
  // The landing org: the one just joined when accepted, else the session's own default (the cookie orgId is
  // only a hint — validated against the directory), else the first org they belong to. None at all → sign out
  // rather than bounce them into a dashboard that cannot exist.
  let orgs: Awaited<ReturnType<typeof listUserOrgs>> = [];
  try {
    orgs = await withTenantDb((app) => listUserOrgs(app, session.userId));
  } catch (error) {
    logActionError("invite.directory_read_failed", error);
  }
  const target =
    orgs.find((o) => o.orgId === orgId) ?? orgs.find((o) => o.orgId === session.orgId) ?? orgs[0];
  if (!target) redirect(LOGOUT_URL);

  redirect(`/org/${target.slug}/dashboard?invite=${outcome}`);
}
