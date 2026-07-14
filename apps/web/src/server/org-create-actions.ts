"use server";

import { countOwnedFreeOrgs } from "@webhook-co/db/org-lifecycle";
import { createOrgWithOwner, InvalidOrgSlugError, SlugTakenError } from "@webhook-co/db/orgs";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { MAX_FREE_ORGS_PER_USER } from "@webhook-co/shared/plans";
import { suggestOrgSlug } from "@webhook-co/shared";
import { redirect } from "next/navigation";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { verifySession } from "./session";

// Create a new organization (a "team"). This is the FIRST prod caller of createOrgWithOwner — until now every
// org in the system was a personal org minted by the auth bootstrap.
//
// Gated on verifySession, NOT requireOrgAccess: you do not need to belong to an org to create one — the org
// you are creating does not exist yet, and you become its owner. The caller is the authenticated user; the
// owner membership is written in the same transaction as the org (createOrgWithOwner is atomic, so a crash can
// never leave a zero-member orphan).

const MAX_NAME_LEN = 100;
const MAX_SLUG_ATTEMPTS = 8;

export type CreateTeamResult = { readonly ok: false; readonly error: string };
// On success this REDIRECTS (throws), so it never returns ok:true — a returned value is always an error the
// form renders inline.

/**
 * Create a team from a display name, deriving a URL slug and landing on the new org's dashboard.
 *
 * The user supplies a name; we derive the slug (they can change it later in settings). A slug collision — with
 * a live org OR a retired one — is retried with a fresh suffix, up to a bound; exhausting it is a genuine
 * "couldn't find a free URL" error, not a silent failure.
 */
export async function createTeamAction(formData: FormData): Promise<CreateTeamResult> {
  const session = await verifySession();

  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name.length === 0) return { ok: false, error: "Give your team a name." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.` };
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
        error: "We couldn't find a free URL for that name. Try a different name.",
      };
    }
    if (error instanceof InvalidOrgSlugError) {
      // suggestOrgSlug is contracted to produce valid slugs, so this is a bug, not user input — log and show
      // a generic message rather than leaking the internal reason.
      logActionError("org.create_invalid_slug", error);
      return { ok: false, error: "That name can't be used. Try a different one." };
    }
    logActionError("org.create_failed", error);
    return { ok: false, error: "We couldn't create the team. Please try again." };
  }

  // Land in the new org. Outside the try/catch — redirect() throws its control signal and must not be caught.
  redirect(`/org/${slug}/dashboard?created=1`);
}
