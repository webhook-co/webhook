"use server";

import {
  renameOrg,
  InvalidOrgSlugError,
  RenameForbiddenError,
  SlugTakenError,
} from "@webhook-co/db/orgs";
import { orgSlugErrorMessage, validateOrgSlug, type OrgSlugError } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { redirect } from "next/navigation";

import { withTenantDb } from "./db";
import { getOnboardingBinding } from "./env";
import { getAuditChainKey } from "./env";
import { logActionError } from "./action-log";
import { classifyMembership } from "./onboarding-logic";
import { readUserOrgDirectory } from "./org-directory";
import { verifySession } from "./session";

// dal-gate-allow: user-scoped — gates on verifySession; the identity write is over the auth. binding (keyed by
// the verified userId), the org rename is the user's OWN personal org (derived + role re-checked). No URL org.

const MAX_NAME_LEN = 80;

export type CompleteOnboardingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      readonly field?: "firstName" | "lastName" | "orgName" | "orgSlug";
    };

/**
 * Finish onboarding: save the user's name and (for a fresh signup) rename their personal org, then flip the
 * `onboardedAt` gate.
 *
 * ── The write ORDER is the correctness argument ─────────────────────────────────────────────────────────
 *
 * These are two different systems — the org rename is a webhook_app tenant write, and stamping `onboardedAt`
 * is an RPC into webhook_auth's identity realm — so they cannot be one transaction. The order makes a partial
 * failure recoverable rather than confusing:
 *
 *   1. Rename the org FIRST. It is idempotent-ish: on a retry the same name is a no-op, and the user can still
 *      change it in settings later.
 *   2. Stamp `onboardedAt` LAST, because THAT is the gate. If anything above fails, the stamp never happens,
 *      the user is still "not onboarded", and their next login simply shows the screen again — with the org
 *      already renamed, so the retry is trivial. Flip the gate before the work it gates on and a failure
 *      strands the user past onboarding with the work half-done; flip it last and a failure just means "try
 *      again".
 */
export async function completeOnboardingAction(
  formData: FormData,
): Promise<CompleteOnboardingResult> {
  const session = await verifySession();

  const firstName = (formData.get("firstName") as string | null)?.trim() ?? "";
  const lastName = (formData.get("lastName") as string | null)?.trim() ?? "";
  const orgName = (formData.get("orgName") as string | null)?.trim();
  const orgSlug = (formData.get("orgSlug") as string | null)?.trim();
  // A whitelisted invite-status flag carried through onboarding (from `/?invite=…`), appended to the landing so
  // a brand-new invitee still gets their confirmation. Whitelisted here too — never an open query passthrough.
  const rawInvite = (formData.get("invite") as string | null) ?? undefined;
  const inviteQuery =
    rawInvite && ["accepted", "invalid", "error"].includes(rawInvite) ? `?invite=${rawInvite}` : "";

  if (firstName.length === 0) {
    return { ok: false, error: "Tell us your first name.", field: "firstName" };
  }
  // Attribute a too-long name to the OFFENDING field — a long last name marked as a first-name error would
  // paint the wrong (valid) field red and send the user to fix the wrong one.
  if (firstName.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep names under ${MAX_NAME_LEN} characters.`, field: "firstName" };
  }
  if (lastName.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep names under ${MAX_NAME_LEN} characters.`, field: "lastName" };
  }

  const binding = getOnboardingBinding();
  if (!binding) {
    // Unbound means we cannot persist identity — better to fail loudly than to pretend it saved.
    return { ok: false, error: "Onboarding is temporarily unavailable. Please try again shortly." };
  }

  // Re-check the gate authoritatively before any write — the REPLAY guard. An already-onboarded user (a
  // double-submit, a stale/replayed POST) re-invoking this would otherwise re-rename their org and re-stamp
  // `onboardedAt`; a changed slug is retired forever by the never-recycle trigger, so a replay could silently
  // rotate their URL and burn the old one. If they are already onboarded, this is a no-op: bounce to `/`.
  //
  // FAIL CLOSED on a read fault. The org rename below is destructive and irreversible, so without a definite
  // "already onboarded?" answer we must not proceed on a guess — better to ask the user to retry (onboarding
  // is once-off; a read fault is transient). The redirect is OUTSIDE the try: redirect() throws to signal, and
  // catching that here would turn a successful short-circuit into a logged "read failed".
  let current;
  try {
    current = await binding.read(session.userId);
  } catch (error) {
    logActionError("onboarding.recheck_read_failed", error);
    return { ok: false, error: "We couldn't reach your account just now. Please try again." };
  }
  if (current !== null && current.onboardedAtIso !== null) redirect("/");

  // Fresh vs invited, from the directory (authoritative) — via the SAME classification the gate uses, so what
  // the user was shown and what we enforce here can never drift.
  const orgs = await readUserOrgDirectory(session.userId);
  const {
    personalId: personal,
    personalOrg: mine,
    invited,
  } = classifyMembership(session.userId, orgs);

  // Step 1 — rename the personal org for a FRESH signup. An invited teammate skips this entirely; a fresh
  // signup whose personal org is missing (a bootstrap blip) saves their name only.
  let landing = "/";
  if (!invited && mine !== null) {
    if (orgName === undefined) {
      // Render/submit RACE: the form rendered in INVITED mode (it sent no org fields at all) but the directory
      // now classifies this user as fresh — their team membership was revoked between render and submit. Don't
      // hard-block on a field they were never shown; onboard name-only (they can name the org later in
      // settings). `undefined` (field absent) is distinct from `""` (fresh-mode field the user cleared).
      logActionError("onboarding.membership_race", new Error("membership_race"));
    } else if (orgName.length === 0) {
      // A fresh-mode form with the name cleared cannot silently keep the machine-generated name.
      return { ok: false, error: "Give your organization a name.", field: "orgName" };
    } else if (orgName.length > MAX_NAME_LEN) {
      return {
        ok: false,
        error: `Keep the name under ${MAX_NAME_LEN} characters.`,
        field: "orgName",
      };
    } else {
      const slug = orgSlug ?? "";
      const check = validateOrgSlug(slug);
      if (!check.ok)
        return { ok: false, error: orgSlugErrorMessage(check.reason), field: "orgSlug" };
      // `mine` is non-null here (needsOrgName implies it); the role is re-read from the directory (never
      // trusted from the client), and renameOrg re-checks owner/admin regardless.
      // Resolve the audit key BEFORE opening the pool (fail-closed getAuditChainKey must not strand a pool),
      // and so the withTenantDb callback stays synchronous around one awaited renameOrg.
      const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
      try {
        const result = await withTenantDb((app) =>
          renameOrg(app, {
            orgId: personal,
            actorRole: mine.role,
            actorId: session.userId,
            name: orgName,
            slug: slug !== mine.slug ? slug : undefined,
            auditKey,
          }),
        );
        landing = `/org/${result.slug}/dashboard`;
      } catch (error) {
        if (error instanceof SlugTakenError) {
          return { ok: false, error: "That URL is already taken. Try another.", field: "orgSlug" };
        }
        if (error instanceof InvalidOrgSlugError) {
          return {
            ok: false,
            error: orgSlugErrorMessage(error.reason as OrgSlugError),
            field: "orgSlug",
          };
        }
        if (error instanceof RenameForbiddenError) {
          // Should not happen for one's own personal org, but never onboard on a forbidden write.
          return { ok: false, error: "You can't rename that organization." };
        }
        logActionError("onboarding.rename_failed", error);
        return { ok: false, error: "We couldn't save your organization. Please try again." };
      }
    }
  } else if (invited) {
    // Land the invited teammate ON the team they just joined, not on `/`. The `/` resolver picks the session's
    // "last acting org" hint (or the first membership), which for a just-invited user can still be their empty
    // personal org — dropping them there instead of the team is the opposite of what accepting an invite meant.
    const team = orgs.find((o) => o.orgId !== personal);
    if (team) landing = `/org/${team.slug}/dashboard${inviteQuery}`;
  } else {
    // No personal org to rename (a bootstrap blip) and not invited. Don't fail onboarding over it — save the
    // name below and let `/` resolve wherever it can.
    logActionError("onboarding.no_personal_org", new Error("no_personal_org"));
  }

  // Step 2 — flip the gate LAST. Only now is the user "onboarded".
  try {
    const { completed } = await binding.complete(session.userId, firstName, lastName);
    if (!completed) {
      // The user row vanished (raced with a delete). Treat as done rather than looping.
      logActionError("onboarding.complete_no_row", new Error("complete_no_row"));
    }
  } catch (error) {
    logActionError("onboarding.complete_failed", error);
    return { ok: false, error: "We couldn't finish setting up your account. Please try again." };
  }

  // Success. If we renamed, land on the org's dashboard directly; otherwise `/` resolves the default org (and
  // re-checks onboarding, which now returns "done", so there is no loop).
  redirect(landing);
}
