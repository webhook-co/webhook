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
 * The ship DATE of the onboarding columns (migrations 0073/0074), at UTC midnight. A user whose `createdAt`
 * predates this signed up before onboarding existed, so a null `onboardedAt` on such a row means "predates the
 * feature", NOT "a fresh signup mid-onboarding".
 *
 * This is a COARSE BACKSTOP, not the primary mechanism, and its bounds are deliberate:
 *   - The PRIMARY mechanism is migration 0074, which backfills every existing user's `onboardedAt`; the deploy
 *     migration-guard blocks the web deploy until it has run. So in prod every pre-existing user's gate is
 *     already decided by the null-check above and this constant is never consulted for them. It only matters
 *     where that ordering can be broken — 0074 skipped/rolled back in prod, or a non-prod env (dev/CI/preview)
 *     that ran 0073 but not 0074 (where the "pre-existing users" are ephemeral test fixtures, not real ones).
 *   - Day-granularity is imperfect ON the ship day: a pre-existing user who signed up earlier the SAME UTC day
 *     (before the deploy) has `createdAt >= this epoch`, so the backstop does NOT cover them — they fall back
 *     to 0074. We intentionally do NOT push the epoch later to catch them, because that would make the OTHER
 *     error possible: a genuinely NEW signup created later the same day would be `< epoch` and get WRONGLY
 *     skipped past onboarding they actually need. Midnight is the safe bound — it can only ever fail to
 *     grandfather (recoverable, and covered by 0074), never wrongly skip a real new signup.
 */
const ONBOARDING_FEATURE_EPOCH_MS = Date.parse("2026-07-14T00:00:00Z");

export interface OnboardingInput {
  readonly userId: string;
  readonly state: OnboardingStateDto | null;
  readonly orgs: readonly UserOrg[];
}

/** How a user's memberships classify them for onboarding — the ONE definition the gate and the write share. */
export interface MembershipClassification {
  /** The user's derived personal org id. */
  readonly personalId: string;
  /** Their personal-org membership, or null if it is somehow absent (a bootstrap blip). */
  readonly personalOrg: UserOrg | null;
  /** True if they hold a membership in ANY org other than their personal one → they were invited to a team. */
  readonly invited: boolean;
}

/**
 * Classify a user as fresh-vs-invited from their org directory. Shared by the gate (what onboarding SHOWS) and
 * the action (what it ENFORCES) so the two can never drift — a fresh signup's only membership is their derived
 * personal org (still machine-named); an invited teammate additionally belongs to the org they were invited to.
 */
export function classifyMembership(
  userId: string,
  orgs: readonly UserOrg[],
): MembershipClassification {
  const personalId = personalOrgId(userId);
  return {
    personalId,
    personalOrg: orgs.find((o) => o.orgId === personalId) ?? null,
    invited: orgs.some((o) => o.orgId !== personalId),
  };
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
  const { invited, personalOrg } = classifyMembership(input.userId, input.orgs);

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
