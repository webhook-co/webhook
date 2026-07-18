"use server";

import { isPersonalOrg } from "@webhook-co/db/org-lifecycle";
import {
  InvalidOrgSlugError,
  renameOrg,
  RenameForbiddenError,
  SlugTakenError,
} from "@webhook-co/db/orgs";
import { sessionCookieOptions } from "./session-cookie";
import {
  orgSlugErrorMessage,
  userActor,
  validateOrgSlug,
  type OrgSlugError,
} from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { logActionError } from "./action-log";
import { getTenantDb, withTenantDb } from "./db";
import { deleteOrRequestOrg } from "./org-delete";
import { getAuditChainKey } from "./env";
import { requireOrgAccess } from "./org-access";
import { LOGOUT_URL, SESSION_COOKIE } from "./session";

/**
 * Permanently delete the current organization, PRESERVING the tamper-evident WORM audit trail and enqueuing
 * the durable R2 payload-body purge. HOW the Postgres data goes depends on the ASYNC_ORG_DELETION flag (see
 * deleteOrRequestOrg): the synchronous path cascade-deletes everything and closes the chain with an
 * `org.deleted` entry; the async path marks the org `deleting` (audit action `org.deletion_requested`),
 * revokes its credentials, and lets the webhook_reaper cron drain the rows — so on the async path the org row
 * lingers until the reaper finalizes it (no `org.deleted` entry fires at request time). OWNER-ONLY: the web
 * session model is otherwise flat ("any member may manage"), which is not enough for an irreversible, org-wide
 * destroy — so we gate on the role from `requireOrgAccess` (which also proves current membership). A typed
 * "DELETE" acknowledgement is required (client gate + re-checked here).
 *
 * On success the org — and therefore this session's tenancy — is gone or being reaped, so we clear the
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

  // The personal organization is the user's identity home, not a disposable team — it may only be shed
  // by deleting the account itself (which has its own ceremony). Blocking its deletion also closes a
  // free-tier abuse loop: bootstrapPersonalOrg re-creates a missing personal org on the next sign-in with
  // a fresh `orgs.created_at`, re-anchoring the one-time Free lifetime allowance (effectiveBillingPeriod),
  // so delete + re-login would otherwise reset the 5,000-event allowance indefinitely. The check is
  // ORG-centric, not caller-centric: an org is personal iff one of ITS OWN owners' personalOrgId equals
  // it — so a SECOND owner of someone's personal org can't delete it either.
  const app = await getTenantDb();
  if (await isPersonalOrg(app, orgId)) {
    throw new Error("the personal organization cannot be deleted");
  }

  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  // The REQUEST owns the client now (see server/db.ts): it is shared by every loader in this render and
  // closed once, after the response. Closing it here would pull the connection out from under the others.
  // Sync hard-delete, or async mark-deleting + reaper + KV credential eviction, per the ASYNC_ORG_DELETION
  // flag (#665) — see deleteOrRequestOrg.
  await deleteOrRequestOrg(app, { orgId, actor: userActor(userId) }, auditKey);

  // Same attributes as the set — a `__Host-` cookie cleared without `Secure` is rejected by the browser
  // and the session would survive (RFC 6265bis §4.1.3).
  (await cookies()).delete({ name: SESSION_COOKIE, ...sessionCookieOptions() });
  redirect(LOGOUT_URL);
}

const MAX_NAME_LEN = 100;

export type RenameOrgResult = {
  readonly ok: false;
  readonly error: string;
  readonly field?: "name" | "slug";
};
// On success this REDIRECTS to the (possibly new) canonical URL and never returns ok:true.

/**
 * Rename the org — its display name, its slug, or both.
 *
 * Gated on `requireOrgAccess(slug)` (proves membership + yields the role), then `renameOrg` enforces
 * owner/admin server-side. The slug is validated in TS for a friendly message, but the DB is the authority —
 * a taken slug (live OR retired, via the never-recycle guard) comes back as `SlugTakenError` and is shown as
 * "that URL is taken". On a slug change we redirect to the NEW canonical URL; the old one still resolves (the
 * retired-slug 308) but landing on the new address is honest.
 */
export async function renameOrgAction(slug: string, formData: FormData): Promise<RenameOrgResult> {
  const { orgId, userId, role } = await requireOrgAccess(slug);

  const nameRaw = formData.get("name");
  const slugRaw = formData.get("slug");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : undefined;
  const nextSlug = typeof slugRaw === "string" ? slugRaw.trim() : undefined;

  if (name !== undefined && name.length === 0) {
    return { ok: false, error: "A name can't be empty.", field: "name" };
  }
  if (name !== undefined && name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.`, field: "name" };
  }
  if (nextSlug !== undefined && nextSlug !== slug) {
    const check = validateOrgSlug(nextSlug);
    if (!check.ok) return { ok: false, error: orgSlugErrorMessage(check.reason), field: "slug" };
  }

  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));

  let landingSlug: string;
  try {
    const result = await withTenantDb((app) =>
      renameOrg(app, {
        orgId,
        actorRole: role,
        actorId: userId,
        name,
        // Only pass slug when it actually changed — an unchanged slug should not attempt a self-collision.
        slug: nextSlug !== undefined && nextSlug !== slug ? nextSlug : undefined,
        auditKey,
      }),
    );
    landingSlug = result.slug;
  } catch (error) {
    if (error instanceof SlugTakenError) {
      return { ok: false, error: "That URL is already taken. Try another.", field: "slug" };
    }
    if (error instanceof InvalidOrgSlugError) {
      // reason originates from validateOrgSlug, so it is an OrgSlugError; the DB carries it as a bare string.
      return { ok: false, error: orgSlugErrorMessage(error.reason as OrgSlugError), field: "slug" };
    }
    if (error instanceof RenameForbiddenError) {
      return { ok: false, error: "Only an owner or admin can rename the organization." };
    }
    logActionError("org.rename_failed", error);
    return { ok: false, error: "We couldn't rename the organization. Please try again." };
  }

  // Outside the try/catch. Land on the (possibly new) canonical URL — the old one still 308s here, but the
  // address bar should show the truth.
  redirect(`/org/${landingSlug}/settings?renamed=1`);
}
