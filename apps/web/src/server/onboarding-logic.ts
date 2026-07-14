import "server-only";

import { personalOrgId, type UserOrg } from "@webhook-co/db/orgs";
import { splitName } from "@webhook-co/shared";

import type { OnboardingStateDto } from "./env";

/**
 * The onboarding decision, as a PURE function of state the caller has already fetched — so every branch
 * (shown / skipped / invited / fresh) is testable without a database or an RPC.
 *
 * Two questions, decided here:
 *
 *   1. **Do we show onboarding at all?** Only when `onboardedAt` is null. After migration 0074 grandfathered
 *      every existing user, a null means precisely "a new signup that has not finished onboarding" — so this
 *      is a clean boolean, not a heuristic about org names.
 *
 *   2. **Does this user name an org?** Only a FRESH signup does. A user who arrived via an INVITE already
 *      belongs to a real, already-named org (the one they were invited to) and must not be asked to name
 *      anything — asking would be nonsense, and it would tempt them into renaming a team that is not theirs to
 *      rename. We detect "invited" structurally: they hold a membership in some org OTHER than their own
 *      derived personal org. A fresh signup's only membership is that personal org, still bearing its
 *      machine-generated name — that is the one onboarding offers to rename.
 */
export type OnboardingDecision =
  | { readonly show: false }
  | {
      readonly show: true;
      /** Pre-filled from the provider profile, or split from the composite name for a magic-link signup. */
      readonly firstName: string;
      readonly lastName: string;
      /** True for a fresh signup (name their personal org); false for an invited teammate. */
      readonly needsOrgName: boolean;
      /** The personal org to rename, present only when `needsOrgName`. */
      readonly org: { readonly orgId: string; readonly slug: string; readonly name: string } | null;
    };

/**
 * The instant the onboarding columns (migrations 0073/0074) shipped. Any user in the DB whose `createdAt`
 * predates this could only have signed up BEFORE onboarding existed, so a null `onboardedAt` on such a row
 * means "predates the feature", NOT "a fresh signup mid-onboarding".
 *
 * This is a BACKSTOP, not the primary mechanism. In prod the deploy migration-guard blocks the web deploy
 * until 0074 has run, and 0074 backfills every existing user's `onboardedAt` — so their gate is already
 * decided by the null-check below. This constant only matters if that ordering is ever broken (0074 skipped
 * or rolled back while this code is live): without it, every pre-existing user would be force-marched through
 * an onboarding screen that offers to rename their real, in-use org. It is exactly the "check the user
 * predates the feature" guard migration 0073's note promised. A genuinely new signup is always created AFTER
 * this instant, so the backstop can never wrongly SKIP onboarding for someone who needs it.
 */
const ONBOARDING_FEATURE_EPOCH_MS = Date.parse("2026-07-14T00:00:00Z");

export interface OnboardingInput {
  readonly userId: string;
  readonly state: OnboardingStateDto | null;
  readonly orgs: readonly UserOrg[];
}

export function decideOnboarding(input: OnboardingInput): OnboardingDecision {
  const { state } = input;

  // No identity state (the RPC couldn't reach auth, or the user vanished) → don't trap them in onboarding.
  // The gate fails OPEN: a missing signal sends them to the dashboard, never into a loop.
  if (!state) return { show: false };

  // Already onboarded — the common case on every login after the first.
  if (state.onboardedAtIso !== null) return { show: false };

  // Backstop for a broken migration order: a null `onboardedAt` on a row that predates the feature is a
  // pre-existing user 0074 should have grandfathered, not a fresh signup. Treat them as onboarded rather than
  // force-marching them through a screen that offers to rename their real org. (In prod the deploy guard makes
  // this unreachable — 0074 runs first — but it costs nothing and closes the window if that order ever slips.)
  const createdMs = Date.parse(state.createdAtIso);
  if (!Number.isNaN(createdMs) && createdMs < ONBOARDING_FEATURE_EPOCH_MS) return { show: false };

  // Pre-fill the name. Prefer the provider-mapped first/last; fall back to splitting the composite name for a
  // magic-link user who has no given/family fields. The shared `splitName` returns undefined for empties, so
  // coerce to "" — these become form field values, which must be strings.
  const split = splitName(state.name);
  const firstName = state.firstName ?? split.firstName ?? "";
  const lastName = state.lastName ?? split.lastName ?? "";

  // Invited?  They hold a membership in an org that is NOT their derived personal one.
  const personal = personalOrgId(input.userId);
  const invited = input.orgs.some((o) => o.orgId !== personal);
  const personalOrg = input.orgs.find((o) => o.orgId === personal) ?? null;

  return {
    show: true,
    firstName,
    lastName,
    // A fresh signup names their org; an invited teammate does not. And if — through a bootstrap blip — the
    // user has no personal org to rename, there is nothing to name either, so skip that step rather than
    // present a control that would fail.
    needsOrgName: !invited && personalOrg !== null,
    org: !invited && personalOrg ? personalOrg : null,
  };
}
