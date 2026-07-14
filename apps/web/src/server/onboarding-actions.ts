"use server";

import {
  renameOrg,
  InvalidOrgSlugError,
  RenameForbiddenError,
  SlugTakenError,
} from "@webhook-co/db/orgs";
import { personalOrgId } from "@webhook-co/db/orgs";
import { orgSlugErrorMessage, validateOrgSlug, type OrgSlugError } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { redirect } from "next/navigation";

import { withTenantDb } from "./db";
import { getOnboardingBinding } from "./env";
import { getAuditChainKey } from "./env";
import { logActionError } from "./action-log";
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
      readonly field?: "firstName" | "orgName" | "orgSlug";
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

  if (firstName.length === 0) {
    return { ok: false, error: "Tell us your first name.", field: "firstName" };
  }
  if (firstName.length > MAX_NAME_LEN || lastName.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep names under ${MAX_NAME_LEN} characters.`, field: "firstName" };
  }

  const binding = getOnboardingBinding();
  if (!binding) {
    // Unbound means we cannot persist identity — better to fail loudly than to pretend it saved.
    return { ok: false, error: "Onboarding is temporarily unavailable. Please try again shortly." };
  }

  // Step 1 — rename the personal org, IF this was a fresh signup that supplied one. An invited teammate sends
  // no org fields, so this whole block is skipped and they only save their name.
  let landing = "/";
  if (orgName !== undefined && orgName.length > 0) {
    if (orgName.length > MAX_NAME_LEN) {
      return {
        ok: false,
        error: `Keep the name under ${MAX_NAME_LEN} characters.`,
        field: "orgName",
      };
    }
    const slug = orgSlug ?? "";
    const check = validateOrgSlug(slug);
    if (!check.ok) return { ok: false, error: orgSlugErrorMessage(check.reason), field: "orgSlug" };

    // The org is the user's OWN derived personal org; the role is re-read from their directory (never trusted
    // from the client), and renameOrg re-checks owner/admin regardless.
    const personal = personalOrgId(session.userId);
    const orgs = await readUserOrgDirectory(session.userId);
    const mine = orgs.find((o) => o.orgId === personal);
    if (!mine) {
      // No personal org to rename (a bootstrap blip). Don't fail onboarding over it — save the name below.
      logActionError("onboarding.no_personal_org", new Error(session.userId));
    } else {
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
  }

  // Step 2 — flip the gate LAST. Only now is the user "onboarded".
  try {
    const { completed } = await binding.complete(session.userId, firstName, lastName);
    if (!completed) {
      // The user row vanished (raced with a delete). Treat as done rather than looping.
      logActionError("onboarding.complete_no_row", new Error(session.userId));
    }
  } catch (error) {
    logActionError("onboarding.complete_failed", error);
    return { ok: false, error: "We couldn't finish setting up your account. Please try again." };
  }

  // Success. If we renamed, land on the org's dashboard directly; otherwise `/` resolves the default org (and
  // re-checks onboarding, which now returns "done", so there is no loop).
  redirect(landing);
}
