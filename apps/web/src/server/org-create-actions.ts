"use server";

import { countOwnedFreeOrgs } from "@webhook-co/db/org-lifecycle";
import { createOrgWithOwner, InvalidOrgSlugError, SlugTakenError } from "@webhook-co/db/orgs";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { MAX_FREE_ORGS_PER_USER } from "@webhook-co/shared/plans";
import { orgSlugErrorMessage, suggestOrgSlug, validateOrgSlug } from "@webhook-co/shared";
import { redirect } from "next/navigation";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { verifySession } from "./session";

// Create a new organization. This is the FIRST prod caller of createOrgWithOwner — until now every
// org in the system was a personal org minted by the auth bootstrap.
//
// Gated on verifySession, NOT requireOrgAccess: you do not need to belong to an org to create one — the org
// you are creating does not exist yet, and you become its owner. The caller is the authenticated user; the
// owner membership is written in the same transaction as the org (createOrgWithOwner is atomic, so a crash can
// never leave a zero-member orphan).

const MAX_NAME_LEN = 100;
const MAX_SLUG_ATTEMPTS = 8;

export type CreateTeamResult = { readonly ok: false; readonly error: string };
// On success `createTeamAction` REDIRECTS (throws), so it never returns ok:true — a returned value is always an
// error the form renders inline.

/** Like {@link CreateTeamResult} but RETURNS the new slug on success instead of redirecting — for the
 *  logo-at-create path, where the client must upload the cropped logo (which needs the new slug) BEFORE it
 *  navigates to the org. */
export type CreateTeamSlugResult =
  { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string };

/**
 * The shared create core: validate → free-org cap → create (with the chosen slug, or a derived+suffixed one) →
 * return the slug. NO redirect (the callers decide). When the form supplies a slug, we use exactly it — a
 * collision is a real "that URL is taken" error, not something to silently rewrite. When no slug is supplied,
 * we derive it from the name and retry a random suffix on collision, up to a bound.
 */
async function createOrgForOwner(formData: FormData): Promise<CreateTeamSlugResult> {
  const session = await verifySession();

  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name.length === 0) return { ok: false, error: "Give your organization a name." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.` };
  }

  // The chosen URL slug (the form always sends one; a direct caller may omit it → derive from the name).
  // Validate it in TS for a friendly message, but the DB stays the authority (a taken/retired slug still
  // comes back as SlugTakenError below).
  const slugRaw = formData.get("orgSlug");
  const chosenSlug = typeof slugRaw === "string" ? slugRaw.trim() : "";
  if (chosenSlug) {
    const check = validateOrgSlug(chosenSlug);
    if (!check.ok) return { ok: false, error: orgSlugErrorMessage(check.reason) };
  }

  // Cap the FREE organizations one user may own (paid orgs are unlimited). The Free allowance is per-org,
  // so without this a user could mint unlimited free allowance by creating unlimited free orgs. Checked
  // BEFORE any create work, so we never create an org we'd immediately have to reject. A newly created org
  // is always Free at birth, so this caps org creation for non-payers at MAX_FREE_ORGS_PER_USER.
  //
  // This is a BEST-EFFORT gate, not the authoritative boundary: a check-then-create race (double-submit)
  // could overshoot, and a paid org downgraded back to Free later leaves a user over the cap — neither is
  // catchable here. The authoritative enforcement is the periodic free-org-cap reconciler (its own slice),
  // which re-counts owned Free orgs and disables the overflow. This gate just gives immediate, honest
  // feedback for the common case instead of silently creating an org the reconciler will later pause.
  const ownedFreeOrgs = await withTenantDb((app) => countOwnedFreeOrgs(app, session.userId));
  if (ownedFreeOrgs >= MAX_FREE_ORGS_PER_USER) {
    return {
      ok: false,
      error:
        `You can own up to ${MAX_FREE_ORGS_PER_USER} free organizations. Upgrade an existing ` +
        "organization to a paid plan to create another.",
    };
  }

  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));

  let slug: string;
  try {
    slug = await withTenantDb(async (app) => {
      if (chosenSlug) {
        // The user picked the URL — try exactly it. A collision surfaces as a "taken" error (below); we do
        // NOT rewrite it to a random suffix, which would silently discard their choice.
        await createOrgWithOwner(app, {
          slug: chosenSlug,
          name,
          ownerUserId: session.userId,
          auditKey,
        });
        return chosenSlug;
      }
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        // A fresh RANDOM candidate each iteration (suggestOrgSlug re-draws its suffix), so a collision retries
        // an independent slug rather than re-deriving the same one.
        const candidate = suggestOrgSlug(name);
        try {
          await createOrgWithOwner(app, {
            slug: candidate,
            name,
            ownerUserId: session.userId,
            auditKey,
          });
          return candidate;
        } catch (error) {
          // A taken slug (live or retired) is the ONLY retryable failure — try a fresh suffix. Anything else
          // (a real DB fault, an unexpected InvalidOrgSlugError) is not a collision and must surface.
          if (error instanceof SlugTakenError && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
          throw error;
        }
      }
      throw new SlugTakenError(""); // unreachable: the loop either returns or throws inside
    });
  } catch (error) {
    if (error instanceof SlugTakenError) {
      return {
        ok: false,
        error: chosenSlug
          ? "That URL is already taken. Try another."
          : "We couldn't find a free URL for that name. Try a different name.",
      };
    }
    if (error instanceof InvalidOrgSlugError) {
      // A CHOSEN slug can't reach here: we already ran the same validateOrgSlug on it above (line ~59) before
      // the DB, and createOrgWithOwner validates with that identical function — so if ours passed, the DB's did
      // too. This branch is therefore only the DERIVED path, where suggestOrgSlug is contracted to produce a
      // valid slug: an InvalidOrgSlugError here is a bug, not user input — log it and show a generic message
      // rather than leaking the internal reason.
      logActionError("org.create_invalid_slug", error);
      return { ok: false, error: "That name can't be used. Try a different one." };
    }
    logActionError("org.create_failed", error);
    return { ok: false, error: "We couldn't create the organization. Please try again." };
  }

  return { ok: true, slug };
}

/**
 * Create an organization and land on its dashboard. The no-logo path: on success it REDIRECTS (throws), so a
 * returned value is always an error the form renders inline.
 */
export async function createTeamAction(formData: FormData): Promise<CreateTeamResult> {
  const result = await createOrgForOwner(formData);
  if (!result.ok) return result;
  // Land in the new org. Outside any try/catch — redirect() throws its control signal and must not be caught.
  redirect(`/org/${result.slug}/dashboard?created=1`);
}

/**
 * The logo-at-create variant: create the org and RETURN its slug (no redirect), so the client can upload the
 * cropped logo — which needs the new slug — before navigating to the org.
 */
export async function createTeamReturningSlugAction(
  formData: FormData,
): Promise<CreateTeamSlugResult> {
  return createOrgForOwner(formData);
}
